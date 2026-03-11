const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 2000,
  pingTimeout:  5000,
});

const PORT = process.env.PORT || 3000;

// ─── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── In-memory rooms ──────────────────────────────────────────
// rooms[code] = { p1: socketId, p2: socketId|null, state: GameState, started: bool }
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? genCode() : code; // ensure unique
}

// ─── Game constants (shared with client via message) ──────────
const ARENA_W   = 800;
const ARENA_H   = 400;
const FLOOR_Y   = 330; // y where feet touch ground
const GRAVITY   = 0.6;
const JUMP_VY   = -14;
const MOVE_SPD  = { warrior: 4, ninja: 5 };

// ─── Initial player state factory ────────────────────────────
function makePlayer(side, charType) {
  return {
    side,       // 0 = left (P1), 1 = right (P2)
    charType,   // 'warrior' | 'ninja'
    x: side === 0 ? 150 : ARENA_W - 150,
    y: FLOOR_Y,
    vx: 0,
    vy: 0,
    onGround: true,
    facing: side === 0 ? 1 : -1, // 1=right, -1=left
    hp: 100,
    maxHp: 100,
    state: 'idle',   // idle|walk|jump|punch|kick|special|block|hit|ko
    stateTimer: 0,   // frames remaining in current state
    blockTimer: 0,
    specialCD: 0,    // cooldown frames
    comboCount: 0,
    comboTimer: 0,
    hitstun: 0,      // frames of stun
    pushback: 0,     // x velocity from getting hit
    wins: 0,
  };
}

// ─── Game state factory ───────────────────────────────────────
function makeGameState() {
  return {
    tick:       0,
    roundTimer: 60 * 60, // 60 sec × 60 ticks
    phase:      'fighting', // fighting | roundover | gameover
    roundWinner: null,
    players: [
      makePlayer(0, 'warrior'),
      makePlayer(1, 'ninja'),
    ],
    particles: [],
    roundNum: 1,
  };
}

// ─── Authoritative server tick ────────────────────────────────
// inputs[playerIdx] = { left, right, jump, punch, kick, special, block }
function serverTick(gs, inputs) {
  if (gs.phase !== 'fighting') {
    gs.roundTimer--;
    if (gs.roundTimer <= 0) {
      gs.phase = 'gameover';
    }
    return;
  }

  gs.tick++;
  gs.roundTimer = Math.max(0, gs.roundTimer - 1);

  const [p0, p1] = gs.players;

  // Process each player
  for (let i = 0; i < 2; i++) {
    const p = gs.players[i];
    const opp = gs.players[1 - i];
    const inp = inputs[i] || {};
    processPlayer(p, opp, inp, gs);
  }

  // Update facing (players always face each other)
  for (let i = 0; i < 2; i++) {
    const p = gs.players[i];
    const opp = gs.players[1 - i];
    if (p.hitstun <= 0 && p.state !== 'ko') {
      p.facing = opp.x > p.x ? 1 : -1;
    }
  }

  // Particle update
  gs.particles = gs.particles
    .map(pt => ({ ...pt, x: pt.x + pt.vx, y: pt.y + pt.vy, vy: pt.vy + 0.3, life: pt.life - 1 }))
    .filter(pt => pt.life > 0);

  // Timer expiry → determine winner
  if (gs.roundTimer <= 0) {
    endRound(gs);
  }

  // KO check
  for (let i = 0; i < 2; i++) {
    if (gs.players[i].hp <= 0 && gs.players[i].state !== 'ko') {
      gs.players[i].hp = 0;
      gs.players[i].state = 'ko';
      gs.players[i].stateTimer = 120;
      endRound(gs);
    }
  }
}

function processPlayer(p, opp, inp, gs) {
  // Timers
  if (p.stateTimer > 0) p.stateTimer--;
  if (p.specialCD > 0)  p.specialCD--;
  if (p.comboTimer > 0) p.comboTimer--;
  if (p.comboTimer <= 0) p.comboCount = 0;
  if (p.hitstun > 0) p.hitstun--;

  // KO — no input
  if (p.state === 'ko') {
    applyGravity(p);
    return;
  }

  // Blocking
  const wantsBlock = !!inp.block;
  if (wantsBlock && p.onGround && p.hitstun <= 0) {
    p.state = 'block';
    p.blockTimer = 3; // keep blocking while held
  }
  if (p.blockTimer > 0) p.blockTimer--;
  if (!wantsBlock && p.state === 'block' && p.blockTimer <= 0) {
    p.state = 'idle';
  }

  const isBlocking = p.state === 'block';

  // Attack states — wait them out
  const attackStates = ['punch', 'kick', 'special', 'hit'];
  if (attackStates.includes(p.state) && p.stateTimer > 0) {
    applyGravity(p);
    moveByVelocity(p);
    clampToArena(p);
    return;
  }
  if (attackStates.includes(p.state) && p.stateTimer <= 0) {
    p.state = 'idle';
  }

  // Movement
  if (!isBlocking && p.hitstun <= 0) {
    const spd = MOVE_SPD[p.charType] || 4;
    if (inp.left)  { p.vx = -spd; if (p.onGround) p.state = 'walk'; }
    else if (inp.right) { p.vx = spd; if (p.onGround) p.state = 'walk'; }
    else {
      p.vx *= 0.7; // friction
      if (Math.abs(p.vx) < 0.5) p.vx = 0;
      if (p.onGround && p.state === 'walk') p.state = 'idle';
    }

    // Jump
    if (inp.jump && p.onGround) {
      p.vy = JUMP_VY;
      p.onGround = false;
      p.state = 'jump';
    }

    // Attacks
    if (inp.punch && !['punch','kick','special'].includes(p.state)) {
      startAttack(p, opp, 'punch', gs);
    } else if (inp.kick && !['punch','kick','special'].includes(p.state)) {
      startAttack(p, opp, 'kick', gs);
    } else if (inp.special && p.specialCD <= 0 && !['punch','kick','special'].includes(p.state)) {
      startAttack(p, opp, 'special', gs);
      p.specialCD = 180; // 3 sec cooldown
    }
  }

  applyGravity(p);
  moveByVelocity(p);
  clampToArena(p);
}

function applyGravity(p) {
  if (!p.onGround) {
    p.vy += GRAVITY;
    if (p.vy > 18) p.vy = 18; // terminal velocity
  }
}

function moveByVelocity(p) {
  p.x += p.vx;
  p.y += p.vy;
}

function clampToArena(p) {
  // Floor
  if (p.y >= FLOOR_Y) {
    p.y = FLOOR_Y;
    p.vy = 0;
    p.onGround = true;
    if (p.state === 'jump') p.state = 'idle';
  }
  // Walls
  const W = 32;
  if (p.x < W) { p.x = W; p.vx = 0; }
  if (p.x > ARENA_W - W) { p.x = ARENA_W - W; p.vx = 0; }
}

// Attack data
const ATTACKS = {
  punch: {
    startup: 4, active: 6, recovery: 8,
    damage: { warrior: 8, ninja: 5 },
    range: 70,
    pushback: 3,
    hitstun: 12,
    blockDmg: 2,
  },
  kick: {
    startup: 6, active: 8, recovery: 10,
    damage: { warrior: 12, ninja: 8 },
    range: 80,
    pushback: 5,
    hitstun: 18,
    blockDmg: 3,
  },
  special: {
    startup: 8, active: 12, recovery: 15,
    damage: { warrior: 22, ninja: 16 },
    range: 120,
    pushback: 9,
    hitstun: 25,
    blockDmg: 6,
  },
};

function startAttack(p, opp, type, gs) {
  const atk = ATTACKS[type];
  p.state = type;
  p.stateTimer = atk.startup + atk.active + atk.recovery;

  // Check hit during active frames (simplified: instant check)
  const dist = Math.abs(p.x - opp.x);
  if (dist <= atk.range) {
    const dmg = atk.damage[p.charType] || 8;

    if (opp.state === 'block') {
      // Chip damage
      opp.hp = Math.max(0, opp.hp - atk.blockDmg);
      spawnParticles(gs, opp.x, opp.y - 40, 3, '#4488ff');
    } else if (opp.hitstun <= 0 && opp.state !== 'ko') {
      // Full hit
      opp.hp = Math.max(0, opp.hp - dmg);
      opp.hitstun = atk.hitstun;
      opp.state = 'hit';
      opp.stateTimer = atk.hitstun;
      const dir = opp.x > p.x ? 1 : -1;
      opp.vx = dir * atk.pushback;
      if (type === 'special') opp.vy = -6;

      // Combo counter
      p.comboCount++;
      p.comboTimer = 90;

      // Blood particles
      spawnParticles(gs, opp.x, opp.y - 40, type === 'special' ? 15 : 8, '#cc0000');
    }
  }
}

function spawnParticles(gs, x, y, count, color) {
  for (let i = 0; i < count; i++) {
    gs.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.8) * 7,
      life: 20 + Math.floor(Math.random() * 20),
      color,
      size: 2 + Math.random() * 3,
    });
  }
}

function endRound(gs) {
  if (gs.phase !== 'fighting') return;

  const [p0, p1] = gs.players;
  let winnerIdx = null;

  if (p0.hp <= 0 && p1.hp <= 0) {
    // Draw — nobody wins
  } else if (p0.hp <= 0) {
    winnerIdx = 1;
  } else if (p1.hp <= 0) {
    winnerIdx = 0;
  } else {
    // Timer: higher HP wins
    winnerIdx = p0.hp >= p1.hp ? 0 : 1;
  }

  gs.roundWinner = winnerIdx;
  gs.phase = 'roundover';
  gs.roundTimer = 3 * 60; // 3 sec before gameover screen

  if (winnerIdx !== null) {
    gs.players[winnerIdx].wins++;
  }
}

// ─── Socket.io logic ─────────────────────────────────────────
io.on('connection', socket => {
  let currentRoom = null;
  let playerIdx   = null;

  // Create room
  socket.on('createRoom', ({ charType }) => {
    const code = genCode();
    rooms[code] = {
      code,
      p1: { id: socket.id, charType: charType || 'warrior', ready: false },
      p2: null,
      state: null,
      inputs: [
        { left:false, right:false, jump:false, punch:false, kick:false, special:false, block:false },
        { left:false, right:false, jump:false, punch:false, kick:false, special:false, block:false },
      ],
      tickInterval: null,
    };
    currentRoom = code;
    playerIdx   = 0;
    socket.join(code);
    socket.emit('roomCreated', { code, playerIdx: 0 });
  });

  // Join room
  socket.on('joinRoom', ({ code, charType }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Комната не найдена' });
    if (room.p2)   return socket.emit('error', { msg: 'Комната заполнена' });

    room.p2 = { id: socket.id, charType: charType || 'ninja', ready: false };
    currentRoom = code;
    playerIdx   = 1;
    socket.join(code);
    socket.emit('roomJoined', { code, playerIdx: 1 });

    // Both players connected → init game
    const gs = makeGameState();
    gs.players[0].charType = room.p1.charType;
    gs.players[1].charType = room.p2.charType;
    // Recalc speeds based on charType
    room.state = gs;

    io.to(code).emit('gameStart', {
      playerIdx: null, // sent separately
      charTypes: [room.p1.charType, room.p2.charType],
      state: gs,
    });
    // Tell each player their index
    io.to(room.p1.id).emit('yourIndex', 0);
    io.to(room.p2.id).emit('yourIndex', 1);

    // Start server tick at 60 fps
    if (room.tickInterval) clearInterval(room.tickInterval);
    room.tickInterval = setInterval(() => {
      if (!rooms[code]) { clearInterval(room.tickInterval); return; }
      const { state, inputs } = rooms[code];
      if (!state) return;

      serverTick(state, inputs);

      // Reset one-shot inputs after tick
      for (let i = 0; i < 2; i++) {
        inputs[i].punch   = false;
        inputs[i].kick    = false;
        inputs[i].special = false;
        inputs[i].jump    = false;
      }

      io.to(code).emit('tick', state);

      if (state.phase === 'gameover') {
        clearInterval(room.tickInterval);
        room.tickInterval = null;
      }
    }, 1000 / 60);
  });

  // Receive input from client
  socket.on('input', (inp) => {
    if (currentRoom === null || playerIdx === null) return;
    const room = rooms[currentRoom];
    if (!room || !room.inputs) return;
    // Merge: keep button-down states, but one-shots (punch/kick/special/jump) only rise
    const cur = room.inputs[playerIdx];
    cur.left    = !!inp.left;
    cur.right   = !!inp.right;
    cur.block   = !!inp.block;
    if (inp.punch)   cur.punch   = true;
    if (inp.kick)    cur.kick    = true;
    if (inp.special) cur.special = true;
    if (inp.jump)    cur.jump    = true;
  });

  // Rematch
  socket.on('rematch', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || !room.p2) return;
    // Reset state
    const gs = makeGameState();
    gs.players[0].charType = room.p1.charType;
    gs.players[1].charType = room.p2.charType;
    // Keep wins
    gs.players[0].wins = room.state ? room.state.players[0].wins : 0;
    gs.players[1].wins = room.state ? room.state.players[1].wins : 0;
    room.state = gs;

    io.to(currentRoom).emit('rematch', { state: gs });

    if (room.tickInterval) clearInterval(room.tickInterval);
    room.tickInterval = setInterval(() => {
      if (!rooms[currentRoom]) { clearInterval(room.tickInterval); return; }
      const { state, inputs } = rooms[currentRoom];
      if (!state) return;
      serverTick(state, inputs);
      for (let i = 0; i < 2; i++) {
        inputs[i].punch   = false;
        inputs[i].kick    = false;
        inputs[i].special = false;
        inputs[i].jump    = false;
      }
      io.to(currentRoom).emit('tick', state);
      if (state.phase === 'gameover') {
        clearInterval(room.tickInterval);
        room.tickInterval = null;
      }
    }, 1000 / 60);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
    io.to(currentRoom).emit('opponentLeft');
    delete rooms[currentRoom];
  });
});

server.listen(PORT, () => {
  console.log(`⚔️  Shadow Kombat Online running on http://localhost:${PORT}`);
});
