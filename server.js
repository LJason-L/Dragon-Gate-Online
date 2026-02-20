const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let rooms = {}; 
const suits = ['♠', '♥', '♦', '♣'];

function generateRoomId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function createInitialGameState() {
    return {
        pool: 0,
        initialPool: 2000,
        passFee: 0,
        maxPlayers: 0, 
        numberOfDecks: 2, 
        deck: [],
        players: {}, 
        playerOrder: [], 
        offlinePlayers: [], // 🚀 新增：保存斷線玩家的資料與盈虧
        currentTurnIndex: 0, 
        tableCards: { c1: null, c2: null, c3: null },
        isPair: false,
        message: "等待玩家加入...",
        messageColor: "white",
        status: 'waiting_for_host' 
    };
}

function initDeck(roomId) {
    let state = rooms[roomId];
    state.deck = [];
    let numDecks = state.numberOfDecks || 2;
    for (let i = 0; i < numDecks; i++) { 
        for (let s of suits) {
            for (let v = 1; v <= 13; v++) { state.deck.push({ suit: s, value: v }); }
        }
    }
    for (let i = state.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.deck[i], state.deck[j]] = [state.deck[j], state.deck[i]];
    }
}

function drawCard(roomId) {
    let state = rooms[roomId];
    if (state.deck.length === 0) initDeck(roomId);
    return state.deck.pop();
}

function executeDeal(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    
    let c1 = drawCard(roomId);
    let c2 = drawCard(roomId);
    if (c1.value > c2.value) [c1, c2] = [c2, c1];

    state.tableCards = { c1, c2, c3: null };
    state.isPair = (c1.value === c2.value);

    let currentPlayerId = state.playerOrder[state.currentTurnIndex];
    if(!state.players[currentPlayerId]) return;
    let pName = state.players[currentPlayerId].name;
    
    state.message = state.isPair ? `😱 撞柱危機！大家看【${pName}】要猜大還猜小！` : `大家都在看【${pName}】要下多少籌碼...`;
    state.messageColor = state.isPair ? "#FF1744" : "white";
    
    io.to(roomId).emit('cards_dealt', state); 
}

function dealInitialCardsForCurrentTurn(roomId) {
    let state = rooms[roomId];
    if(!state) return;

    if (state.deck.length < 3) {
        state.message = "🃏 牌靴見底了，莊家重新洗牌中...";
        state.messageColor = "#FFD700";
        io.to(roomId).emit('update_state', state); 
        io.to(roomId).emit('shuffling_deck'); 
        
        setTimeout(() => {
            initDeck(roomId);
            executeDeal(roomId);
        }, 3000); 
    } else {
        executeDeal(roomId);
    }
}

function nextTurn(roomId) {
    let state = rooms[roomId];
    if(!state || state.status !== 'playing') return; 
    if(state.playerOrder.length === 0) return;
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.playerOrder.length;
    dealInitialCardsForCurrentTurn(roomId);
}

function startGame(roomId) {
    let state = rooms[roomId];
    state.status = 'playing';
    initDeck(roomId);
    
    let costPerPlayer = Math.round(state.initialPool / state.maxPlayers); // 依照最大人數均攤
    for (let id in state.players) {
        state.players[id].pnl -= costPerPlayer;
    }
    
    io.to(roomId).emit('update_state', state); 
    executeDeal(roomId); 
}

io.on('connection', (socket) => {
    
    socket.on('create_room', (playerName) => {
        let roomId = generateRoomId();
        while(rooms[roomId]) roomId = generateRoomId(); 

        socket.join(roomId);
        socket.roomId = roomId; 

        rooms[roomId] = createInitialGameState();
        let state = rooms[roomId];
        
        state.players[socket.id] = { name: playerName, pnl: 0, isHost: true };
        state.playerOrder.push(socket.id);
        state.message = "你是室長，請設定遊戲規則與人數！";
        
        socket.emit('room_joined', roomId); 
        io.to(roomId).emit('update_state', state);
    });

    // 🚀 加入房間邏輯大幅升級 🚀
    socket.on('join_room', (data) => {
        let { playerName, roomId } = data;
        roomId = roomId.toUpperCase();

        if (!rooms[roomId]) {
            return socket.emit('error_msg', "找不到這個包廂！請確認房號。");
        }
        
        let state = rooms[roomId];
        
        // 判斷是否客滿
        if (state.maxPlayers > 0 && state.playerOrder.length >= state.maxPlayers) {
            return socket.emit('error_msg', "這個包廂已經客滿了！");
        }

        // 判斷在線玩家中是否有同名的 (防止自己開兩個分頁)
        let isNameTaken = Object.values(state.players).some(p => p.name === playerName);
        if (isNameTaken) {
             return socket.emit('error_msg', "包廂內已經有同名玩家，請換個名字！");
        }

        socket.join(roomId);
        socket.roomId = roomId;

        // 🚀 尋找是否為「斷線玩家重新連線」
        let offlineIdx = state.offlinePlayers.findIndex(p => p.name === playerName);
        
        if (offlineIdx !== -1) {
            // 從離線區拉回來，恢復盈虧！
            let restoredPlayer = state.offlinePlayers.splice(offlineIdx, 1)[0];
            restoredPlayer.isHost = false; // 恢復身分但不給室長權限
            state.players[socket.id] = restoredPlayer;
            state.message = `🔥 ${playerName} 斷線重連，帶著他的籌碼回歸了！`;
        } else {
            // 全新玩家加入
            state.players[socket.id] = { name: playerName, pnl: 0, isHost: false };
            
            // 如果遊戲已經在進行中，新來的必須補繳一開始的門票費！
            if (state.status === 'playing') {
                let costPerPlayer = Math.round(state.initialPool / state.maxPlayers);
                state.players[socket.id].pnl -= costPerPlayer;
                state.message = `👋 ${playerName} 中途加入牌局！已扣除門票 $${costPerPlayer}`;
            }
        }

        state.playerOrder.push(socket.id);

        if (state.status === 'waiting_for_host') {
            state.message = "等待室長設定規則中...";
        } else if (state.status === 'waiting_for_players') {
            state.message = `等待玩家到齊... (${state.playerOrder.length} / ${state.maxPlayers})`;
            if (state.playerOrder.length >= state.maxPlayers) {
                startGame(roomId);
                socket.emit('room_joined', roomId);
                return;
            }
        }
        
        socket.emit('room_joined', roomId);
        io.to(roomId).emit('update_state', state);
    });

    socket.on('set_pool', (data) => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[0]) return;
        
        state.initialPool = data.amount;
        state.pool = data.amount;
        state.passFee = data.passFee || 0;
        state.maxPlayers = data.maxPlayers || 2; 
        state.numberOfDecks = data.decks || 2; 
        
        if (state.playerOrder.length >= state.maxPlayers) {
            startGame(roomId);
        } else {
            state.status = 'waiting_for_players';
            state.message = `等待玩家到齊... (${state.playerOrder.length} / ${state.maxPlayers})`;
            io.to(roomId).emit('update_state', state);
        }
    });

    socket.on('force_reset', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[0]) return; 
        
        state.pool = 0;
        state.status = 'waiting_for_host'; 
        state.tableCards = { c1: null, c2: null, c3: null };
        state.offlinePlayers = []; // 重置時清空離線紀錄
        state.message = "🛑 莊家已強制重置遊戲！請重新設定人數與彩池。";
        state.messageColor = "#FFD700";
        initDeck(roomId); 
        
        if (state.playerOrder.length > 0) {
            state.currentTurnIndex = (state.currentTurnIndex + 1) % state.playerOrder.length;
        }
        io.to(roomId).emit('update_state', state);
    });

    // 🚀 結算邏輯升級：把逃跑的玩家抓回來算帳 🚀
    socket.on('end_game', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[0]) return; 
        state.status = 'game_over';
        
        let playerCount = state.playerOrder.length; // 剩下的彩池只分給還在線上的活人
        let distributedShare = 0;

        if (playerCount > 0 && state.pool > 0) {
            distributedShare = Math.floor(state.pool / playerCount);
            for (let id in state.players) {
                state.players[id].pnl += distributedShare;
            }
            state.pool = 0; 
        }

        let leaderboard = [];
        // 加入在線玩家
        for (let id in state.players) {
            leaderboard.push(state.players[id]);
        }
        // 加入已斷線玩家 (加上標記)
        for (let p of state.offlinePlayers) {
            p.name = p.name + " (已離線)";
            leaderboard.push(p);
        }
        
        leaderboard.sort((a, b) => b.pnl - a.pnl);

        io.to(roomId).emit('game_ended', { leaderboard: leaderboard, distributedShare: distributedShare });
        state.status = 'waiting_for_host';
        state.offlinePlayers = []; // 結算後清空離線名單
    });

    socket.on('shoot', (data) => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[state.currentTurnIndex]) return;
        
        let { bet, guessType } = data;
        let player = state.players[socket.id];
        
        let minBet = Math.min(state.pool, state.passFee > 0 ? state.passFee : 10);
        if (typeof bet !== 'number' || bet < minBet) return;
        if (bet > state.pool) bet = state.pool; 

        let c3 = drawCard(roomId);
        state.tableCards.c3 = c3;

        let amountChange = 0;
        let { c1, c2 } = state.tableCards;

        if (state.isPair) {
            if (c3.value === c1.value) {
                state.message = `💥 慘！${player.name} 3倍撞柱！賠 $${bet * 3} 💥`;
                amountChange = bet * 3;
                state.messageColor = "#FF1744";
            } else if ((guessType === 'high' && c3.value > c1.value) || (guessType === 'low' && c3.value < c1.value)) {
                state.message = `🎉 神準！${player.name} 贏得 $${bet} 🎉`;
                amountChange = -bet;
                state.messageColor = "#00E676";
            } else {
                state.message = `❌ 猜錯！${player.name} 輸掉 $${bet} ❌`;
                amountChange = bet;
                state.messageColor = "#aaa";
            }
        } else {
            if (c3.value === c1.value || c3.value === c2.value) {
                state.message = `💥 撞柱！${player.name} 賠 $${bet * 2} 💥`;
                amountChange = bet * 2;
                state.messageColor = "#FF1744";
            } else if (c3.value > c1.value && c3.value < c2.value) {
                state.message = `🎉 水啦！${player.name} 進門贏得 $${bet} 🎉`;
                amountChange = -bet;
                state.messageColor = "#00E676";
            } else {
                state.message = `❌ 沒進！${player.name} 輸掉 $${bet} ❌`;
                amountChange = bet;
                state.messageColor = "#aaa";
            }
        }

        state.pool += amountChange;
        player.pnl -= amountChange; 

        let isBankrupt = false;
        if (state.pool <= 0) {
            state.pool = 0;
            state.message += " 🚨 彩池沒了！";
            state.messageColor = "#FFD700";
            isBankrupt = true;
        }

        io.to(roomId).emit('shoot_result', { state: state, resultType: amountChange < 0 ? 'win' : 'lose' });
        
        if (!isBankrupt) {
            setTimeout(() => { nextTurn(roomId); }, 3500);
        } else {
            setTimeout(() => {
                state.pool = state.initialPool;
                let costPerPlayer = Math.round(state.initialPool / state.maxPlayers);
                for (let id in state.players) {
                    state.players[id].pnl -= costPerPlayer; 
                }
                state.message = `💰 自動補血中... 彩池注入 $${state.initialPool} 💰`;
                state.messageColor = "#FFD700";
                
                io.to(roomId).emit('auto_replenish', state);

                setTimeout(() => { nextTurn(roomId); }, 2500);
            }, 3500); 
        }
    });

    socket.on('pass', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[state.currentTurnIndex]) return;
        
        let player = state.players[socket.id];
        let c3 = drawCard(roomId);
        state.tableCards.c3 = c3;

        let fee = state.passFee;
        state.pool += fee; 
        player.pnl -= fee;     

        if (fee > 0) {
            state.message = `💨 ${player.name} 選擇 PASS，支付過路費 $${fee}！`;
        } else {
            state.message = `💨 ${player.name} 覺得門太窄，選擇免費 PASS！`;
        }
        state.messageColor = "#aaa";
        
        io.to(roomId).emit('shoot_result', { state: state, resultType: 'pass' });
        setTimeout(() => { nextTurn(roomId); }, 3000); 
    });

    // 🚀 斷線邏輯升級：保留玩家紀錄 🚀
    socket.on('disconnect', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (state.players[socket.id]) {
            let index = state.playerOrder.indexOf(socket.id);
            let wasHost = state.players[socket.id].isHost;
            
            // 將玩家移到「離線區凍結庫」
            let quittingPlayer = state.players[socket.id];
            quittingPlayer.isHost = false; 
            state.offlinePlayers.push(quittingPlayer);

            // 從當前牌桌移除
            state.playerOrder.splice(index, 1);
            delete state.players[socket.id];
            
            if (state.playerOrder.length > 0) {
                if (wasHost) {
                    state.players[state.playerOrder[0]].isHost = true; 
                }

                if (state.status === 'waiting_for_players') {
                    state.message = `等待玩家到齊... (${state.playerOrder.length} / ${state.maxPlayers})`;
                } else {
                    if (index < state.currentTurnIndex) {
                        state.currentTurnIndex--;
                    } else if (index === state.currentTurnIndex) {
                        state.currentTurnIndex = state.currentTurnIndex % state.playerOrder.length;
                        if (state.status === 'playing') dealInitialCardsForCurrentTurn(roomId);
                    }
                }
                io.to(roomId).emit('update_state', state);
            } else {
                delete rooms[roomId];
            }
        }
    });
});

server.listen(3000, () => {
    console.log('伺服器啟動！等待玩家連線...');
});