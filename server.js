const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let rooms = {}; 
// 🛡️ 導入與 21 點同級的全局計時器管理系統 🛡️
let roomTimers = {}; 

function generateRoomId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// 🛡️ 終極防卡死：全局時間清理函數 🛡️
function clearAllTimers(roomId) {
    if(roomTimers[roomId]) { clearTimeout(roomTimers[roomId]); delete roomTimers[roomId]; }
    if(roomTimers[roomId + '_replenish']) { clearTimeout(roomTimers[roomId + '_replenish']); delete roomTimers[roomId + '_replenish']; }
}

function createInitialGameState() {
    return {
        pool: 0,
        poolPerPlayer: 500, 
        passFee: 0,
        maxPlayers: 0, 
        numberOfDecks: 2, 
        deck: [],
        players: {}, 
        playerOrder: [], 
        offlinePlayers: [], 
        currentTurnIndex: 0, 
        tableCards: { c1: null, c2: null, c3: null },
        isPair: false,
        isActionLocked: false, // 🔒 新增：防連點與幽靈計時器的操作鎖
        message: "等待玩家入座...",
        messageColor: "#F5D061", 
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
    state.isActionLocked = false; // 🔓 開放玩家操作

    let currentPlayerId = state.playerOrder[state.currentTurnIndex];
    if(!state.players[currentPlayerId]) return;
    let player = state.players[currentPlayerId];
    let pName = player.name;
    
    // 🚀 核心修復：嚴格區分「緊鄰死巷」與「撞柱」 🚀
    let gap = c2.value - c1.value;

    if (gap === 1) {
        // 🚨 這是 3 和 4 這種死巷，無牌可打，強制系統代扣並跳過！
        state.isActionLocked = true; // 🔒 鎖死前端按鈕
        let fee = state.passFee > 0 ? state.passFee : 10;
        if (fee > state.pool) fee = state.pool;

        state.pool += fee;
        player.pnl -= fee;

        state.message = `🥶 拿到緊鄰牌 [${c1.value}, ${c2.value}] 無牌可打！${pName} 強制賠付過路費 $${fee}`;
        state.messageColor = "#94a3b8";

        io.to(roomId).emit('cards_dealt', state);
        io.to(roomId).emit('shoot_result', { state: state, resultType: 'pass' });

        clearAllTimers(roomId);
        roomTimers[roomId] = setTimeout(() => { nextTurn(roomId); }, 3000);
        return; // 🛑 完美煞車！絕對不讓前端有機會干擾！
    }

    // 💡 如果是 JJ (gap === 0) 或正常開門 (gap > 1)，就正常等待玩家下注
    state.message = state.isPair ? `⚠️ 撞柱危機！全場看【${pName}】猜大還猜小！` : `全場注視著【${pName}】下注...`;
    state.messageColor = state.isPair ? "#ff4757" : "#f8fafc";
    
    io.to(roomId).emit('cards_dealt', state); 
}

function dealInitialCardsForCurrentTurn(roomId) {
    let state = rooms[roomId];
    if(!state) return;

    if (state.deck.length < 3) {
        state.message = "🃏 牌庫見底，荷官洗牌中...";
        state.messageColor = "#F5D061";
        io.to(roomId).emit('update_state', state); 
        io.to(roomId).emit('shuffling_deck'); 
        
        clearAllTimers(roomId);
        roomTimers[roomId] = setTimeout(() => {
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
    clearAllTimers(roomId); // 🛡️ 確保進入下一個玩家時，時間軸絕對乾淨

    let waitingIds = Object.keys(state.players).filter(id => state.players[id].isWaiting);
    if (state.playerOrder.length <= 1 && waitingIds.length > 0) {
        state.message = "👥 人數過少，自動邀請觀戰 VIP 攜資入局！";
        state.messageColor = "#F5D061";
        
        waitingIds.forEach(id => {
            state.players[id].isWaiting = false;
            state.playerOrder.push(id);
            state.players[id].pnl -= state.poolPerPlayer;
            state.pool += state.poolPerPlayer; 
        });

        io.to(roomId).emit('auto_replenish', state); 
        
        roomTimers[roomId] = setTimeout(() => {
            state.currentTurnIndex = (state.currentTurnIndex + 1) % state.playerOrder.length;
            dealInitialCardsForCurrentTurn(roomId);
        }, 2500);
        return;
    }

    if(state.playerOrder.length === 0) return;
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.playerOrder.length;
    dealInitialCardsForCurrentTurn(roomId);
}

function startGame(roomId) {
    let state = rooms[roomId];
    state.status = 'playing';
    initDeck(roomId);
    clearAllTimers(roomId);
    
    let activeCount = state.playerOrder.length;
    state.pool = state.poolPerPlayer * activeCount;
    
    for (let id of state.playerOrder) {
        state.players[id].pnl -= state.poolPerPlayer;
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
        
        state.players[socket.id] = { name: playerName, pnl: 0, isHost: true, isWaiting: false };
        state.playerOrder.push(socket.id);
        state.message = "室長，請設定 VIP 包廂規則";
        
        socket.emit('room_joined', roomId); 
        io.to(roomId).emit('update_state', state);
    });

    socket.on('join_room', (data) => {
        let { playerName, roomId } = data;
        roomId = roomId.toUpperCase();

        if (!rooms[roomId]) return socket.emit('error_msg', "找不到該包廂，請確認房號。");
        let state = rooms[roomId];
        
        let currentOnlineCount = Object.keys(state.players).length;
        if (state.maxPlayers > 0 && currentOnlineCount >= state.maxPlayers) {
            return socket.emit('error_msg', "VIP 包廂已滿座！");
        }

        let isNameTaken = Object.values(state.players).some(p => p.name === playerName);
        if (isNameTaken) return socket.emit('error_msg', "包廂內已有同名玩家！");

        socket.join(roomId);
        socket.roomId = roomId;

        let offlineIdx = state.offlinePlayers.findIndex(p => p.name === playerName);
        let playerObj = { name: playerName, pnl: 0, isHost: false, isWaiting: false };
        
        if (offlineIdx !== -1) {
            playerObj = state.offlinePlayers.splice(offlineIdx, 1)[0];
            playerObj.isHost = false; 
            state.message = `🔥 ${playerName} 帶著籌碼重返牌桌！`;
        } else {
            state.message = `👋 ${playerName} 進入了包廂`;
        }

        if (state.status === 'playing') {
            playerObj.isWaiting = true;
            state.players[socket.id] = playerObj;
        } else {
            playerObj.isWaiting = false;
            state.players[socket.id] = playerObj;
            state.playerOrder.push(socket.id);
        }

        if (state.status === 'waiting_for_host') {
            state.message = "等待室長設定規則...";
        } else if (state.status === 'waiting_for_players') {
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
        
        state.poolPerPlayer = data.poolPerPlayer; 
        state.passFee = data.passFee || 0;
        state.maxPlayers = data.maxPlayers || 2; 
        state.numberOfDecks = data.decks || 2; 
        
        if (state.playerOrder.length >= state.maxPlayers) {
            startGame(roomId);
        } else {
            state.status = 'waiting_for_players';
            io.to(roomId).emit('update_state', state);
        }
    });

    socket.on('force_start', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[0] || state.status !== 'waiting_for_players') return;
        
        if (state.playerOrder.length >= 2) {
            startGame(roomId);
        } else {
            socket.emit('error_msg', "開局至少需要 2 名玩家！");
        }
    });

    socket.on('force_reset', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[0]) return; 
        
        clearAllTimers(roomId); // 🛡️ 房間重置時也要清空計時器
        state.pool = 0;
        state.status = 'waiting_for_host'; 
        state.tableCards = { c1: null, c2: null, c3: null };
        state.offlinePlayers = []; 
        state.isActionLocked = false;
        
        state.playerOrder = Object.keys(state.players);
        for(let id in state.players) state.players[id].isWaiting = false;

        state.message = "🛑 荷官已重置牌局，請重新設定。";
        state.messageColor = "#ff4757";
        initDeck(roomId); 
        
        io.to(roomId).emit('update_state', state);
    });

    socket.on('end_game', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[0]) return; 
        clearAllTimers(roomId);
        state.status = 'game_over';
        state.isActionLocked = true;
        
        let activeCount = state.playerOrder.length; 
        let distributedShare = 0;

        if (activeCount > 0 && state.pool > 0) {
            distributedShare = Math.floor(state.pool / activeCount);
            for (let id of state.playerOrder) {
                state.players[id].pnl += distributedShare;
            }
        }

        let leaderboard = [];
        for (let id in state.players) leaderboard.push({ ...state.players[id] });
        for (let p of state.offlinePlayers) {
            leaderboard.push({ ...p, name: p.name + " (已離線)" });
        }
        leaderboard.sort((a, b) => b.pnl - a.pnl);

        io.to(roomId).emit('game_ended', { leaderboard: leaderboard, distributedShare: distributedShare });

        state.pool = 0;
        state.status = 'waiting_for_host';
        state.tableCards = { c1: null, c2: null, c3: null };
        state.offlinePlayers = []; 
        
        state.playerOrder = Object.keys(state.players);
        for (let id in state.players) {
            state.players[id].isWaiting = false;
            state.players[id].pnl = 0; 
        }

        state.message = "🏆 結算完成，室長可設定新一局規則";
        state.messageColor = "#F5D061";
        initDeck(roomId); 

        io.to(roomId).emit('update_state', state);
    });

    socket.on('shoot', (data) => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[state.currentTurnIndex]) return;
        if (state.isActionLocked) return; // 🛡️ 核心防護：拒絕連點！
        state.isActionLocked = true; 
        clearAllTimers(roomId); 
        
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
                state.messageColor = "#ff4757";
            } else if ((guessType === 'high' && c3.value > c1.value) || (guessType === 'low' && c3.value < c1.value)) {
                state.message = `🎉 神準！${player.name} 贏得 $${bet} 🎉`;
                amountChange = -bet;
                state.messageColor = "#10b981";
            } else {
                state.message = `❌ 猜錯！${player.name} 失去 $${bet} ❌`;
                amountChange = bet;
                state.messageColor = "#94a3b8";
            }
        } else {
            if (c3.value === c1.value || c3.value === c2.value) {
                state.message = `💥 撞柱！${player.name} 賠 $${bet * 2} 💥`;
                amountChange = bet * 2;
                state.messageColor = "#ff4757";
            } else if (c3.value > c1.value && c3.value < c2.value) {
                state.message = `🎉 水啦！${player.name} 進門贏得 $${bet} 🎉`;
                amountChange = -bet;
                state.messageColor = "#10b981";
            } else {
                state.message = `❌ 射偏！${player.name} 失去 $${bet} ❌`;
                amountChange = bet;
                state.messageColor = "#94a3b8";
            }
        }

        state.pool += amountChange;
        player.pnl -= amountChange; 

        let isBankrupt = false;
        if (state.pool <= 0) {
            state.pool = 0;
            state.message += " 🚨 彩池沒了！";
            state.messageColor = "#F5D061";
            isBankrupt = true;
        }

        io.to(roomId).emit('shoot_result', { state: state, resultType: amountChange < 0 ? 'win' : 'lose' });
        
        if (!isBankrupt) {
            roomTimers[roomId] = setTimeout(() => { nextTurn(roomId); }, 3500);
        } else {
            roomTimers[roomId] = setTimeout(() => {
                for (let id in state.players) {
                    if (state.players[id].isWaiting) {
                        state.players[id].isWaiting = false;
                        state.playerOrder.push(id);
                    }
                }
                
                let activeCount = state.playerOrder.length;
                state.pool = state.poolPerPlayer * activeCount; 
                
                for (let id of state.playerOrder) {
                    state.players[id].pnl -= state.poolPerPlayer; 
                }
                
                state.message = `💰 重新補血！共 ${activeCount} 人入局，每人注資 $${state.poolPerPlayer} 💰`;
                state.messageColor = "#F5D061";
                
                io.to(roomId).emit('auto_replenish', state);
                roomTimers[roomId + '_replenish'] = setTimeout(() => { nextTurn(roomId); }, 2500);
            }, 3500); 
        }
    });

    socket.on('pass', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        if (socket.id !== state.playerOrder[state.currentTurnIndex]) return;
        if (state.isActionLocked) return; // 🛡️ 核心防護
        state.isActionLocked = true;
        clearAllTimers(roomId);
        
        let player = state.players[socket.id];
        let c3 = drawCard(roomId);
        state.tableCards.c3 = c3;

        let fee = state.passFee;
        state.pool += fee; 
        player.pnl -= fee;     

        if (fee > 0) {
            state.message = `💨 ${player.name} 選擇 PASS，支付過路費 $${fee}`;
        } else {
            state.message = `💨 ${player.name} 選擇免費 PASS`;
        }
        state.messageColor = "#94a3b8";
        
        io.to(roomId).emit('shoot_result', { state: state, resultType: 'pass' });
        roomTimers[roomId] = setTimeout(() => { nextTurn(roomId); }, 3000); 
    });

    socket.on('disconnect', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        let state = rooms[roomId];

        let player = state.players[socket.id];
        if (player) {
            let index = state.playerOrder.indexOf(socket.id);
            let wasHost = player.isHost;
            
            player.isHost = false; 
            state.offlinePlayers.push(player);

            if (!player.isWaiting && index !== -1) {
                state.playerOrder.splice(index, 1);
                if (state.playerOrder.length > 0) {
                    if (index < state.currentTurnIndex) {
                        state.currentTurnIndex--;
                    } else if (index === state.currentTurnIndex) {
                        state.currentTurnIndex = state.currentTurnIndex % state.playerOrder.length;
                        // 🛡️ 只有在非鎖定狀態下斷線，才立刻補發新牌，否則讓定時器去處理
                        if (state.status === 'playing' && !state.isActionLocked) {
                            clearAllTimers(roomId);
                            dealInitialCardsForCurrentTurn(roomId);
                        }
                    }
                }
            }
            delete state.players[socket.id];
            
            let onlineIds = Object.keys(state.players);
            if (onlineIds.length > 0) {
                if (wasHost) state.players[onlineIds[0]].isHost = true; 
                
                if(state.status === 'playing' && state.playerOrder.length <= 1) {
                    let waitingIds = Object.keys(state.players).filter(id => state.players[id].isWaiting);
                    if(waitingIds.length > 0) {
                        nextTurn(roomId); 
                    }
                }
                
                io.to(roomId).emit('update_state', state);
            } else {
                clearAllTimers(roomId);
                delete rooms[roomId]; 
            }
        }
    });
});

server.listen(3000, () => {
    console.log('射龍門 VIP 伺服器啟動！等待連線...');
});