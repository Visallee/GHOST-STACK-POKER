// ===========================================================
// GhostStackPoker — tests/run-tests.mjs
// Suíte de testes para as funções puras do projeto.
// Execute com:  node tests/run-tests.mjs
// Requer Node.js >= 14 (suporte a ES Modules).
// ===========================================================

import {
  getOccupiedSeats,
  getActiveSeats,
  nextSeatInRing,
  computeNextDealerSeat,
  computeBlindSeats,
  getNextTurnSeat,
} from '../js/turn.js';

import { getAmountToCall, validateBetAmount } from '../js/betting.js';

import {
  getTableMaxBet,
  isReopeningAction,
  applyActionToRound,
  isBettingRoundClosed,
  getNextSeatToAct,
} from '../js/betting-round.js';

import { computeSidePots, splitPotAmongWinners, sumAllMoney } from '../js/pots.js';

import { evaluateWinCondition, buildFinalResults } from '../js/win-condition.js';

import { CHIP_VALUES, formatMoney } from '../js/chips.js';

import {
  getAfkRemainingMs,
  isPlayerAfk,
  shouldShowAfkWarning,
  formatCountdown,
  computeNextHostByJoinOrder,
  AFK_KICK_THRESHOLD_MS,
  AFK_WARNING_THRESHOLD_MS,
} from '../js/presence.js';

import { generateRoomCode } from '../js/room-code.js';

// ===========================================================
// Mini test runner
// ===========================================================

let passed = 0;
let failed = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n\x1b[36m━━━ ${name} ━━━\x1b[0m`);
}

function test(label, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`    \x1b[33m↳ ${e.message}\x1b[0m`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`Esperado \`${JSON.stringify(expected)}\`, recebeu \`${JSON.stringify(actual)}\``);
      }
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) {
        throw new Error(`Esperado ${b}, recebeu ${a}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Esperado null, recebeu \`${JSON.stringify(actual)}\``);
      }
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Esperado truthy, recebeu \`${JSON.stringify(actual)}\``);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Esperado falsy, recebeu \`${JSON.stringify(actual)}\``);
    },
    toBeGreaterThan(n) {
      if (actual <= n) throw new Error(`Esperado > ${n}, recebeu ${actual}`);
    },
    toBeLessThanOrEqual(n) {
      if (actual > n) throw new Error(`Esperado <= ${n}, recebeu ${actual}`);
    },
    toHaveLength(n) {
      if (actual.length !== n) throw new Error(`Esperado length ${n}, recebeu ${actual.length}`);
    },
    toContain(item) {
      if (!actual.includes(item)) throw new Error(`Esperado que contivesse \`${item}\`, não encontrado em \`${JSON.stringify(actual)}\``);
    },
    toMatch(regex) {
      if (!regex.test(actual)) throw new Error(`\`${actual}\` não corresponde a ${regex}`);
    },
  };
}

// ===========================================================
// Helpers de fixture
// ===========================================================

function makePlayer(overrides = {}) {
  return {
    id: 'player-' + Math.random().toString(36).slice(2, 7),
    name: 'Jogador',
    chips: 1000,
    current_bet: 0,
    folded: false,
    is_eliminated: false,
    seat_number: 1,
    has_acted_this_round: false,
    is_all_in: false,
    last_seen_at: new Date().toISOString(),
    joined_at: new Date().toISOString(),
    ...overrides,
  };
}

// ===========================================================
// GRUPO 1 — chips.js
// ===========================================================

suite('chips.js — CHIP_VALUES e formatMoney');

test('CHIP_VALUES deve ter 6 valores de ficha', () => {
  expect(Object.keys(CHIP_VALUES)).toHaveLength(6);
});

test('ficha preta vale 5', () => {
  expect(CHIP_VALUES.preta).toBe(5);
});

test('ficha azul vale 10', () => {
  expect(CHIP_VALUES.azul).toBe(10);
});

test('ficha vermelha vale 20', () => {
  expect(CHIP_VALUES.vermelha).toBe(20);
});

test('ficha verde vale 50', () => {
  expect(CHIP_VALUES.verde).toBe(50);
});

test('ficha branca vale 100', () => {
  expect(CHIP_VALUES.branca).toBe(100);
});

test('ficha amarela vale 200', () => {
  expect(CHIP_VALUES.amarela).toBe(200);
});

test('formatMoney formata zero como "0"', () => {
  expect(formatMoney(0)).toBe('0');
});

test('formatMoney formata 1000 com separador brasileiro', () => {
  expect(formatMoney(1000)).toBe('1.000');
});

test('formatMoney formata 50000 corretamente', () => {
  expect(formatMoney(50000)).toBe('50.000');
});

// ===========================================================
// GRUPO 2 — room-code.js
// ===========================================================

suite('room-code.js — generateRoomCode');

test('gera código com 6 caracteres', () => {
  expect(generateRoomCode()).toHaveLength(6);
});

test('gera código com apenas letras maiúsculas e dígitos válidos', () => {
  const code = generateRoomCode();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
});

test('não contém caracteres ambíguos (O, 0, I, 1)', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateRoomCode();
    if (/[O0I1]/.test(code)) {
      throw new Error(`Código "${code}" contém caractere ambíguo`);
    }
  }
});

test('gera códigos diferentes a cada chamada', () => {
  const codes = new Set();
  for (let i = 0; i < 10; i++) codes.add(generateRoomCode());
  expect(codes.size).toBeGreaterThan(1);
});

// ===========================================================
// GRUPO 3 — turn.js
// ===========================================================

suite('turn.js — getOccupiedSeats');

test('retorna assentos ordenados de players válidos', () => {
  const players = [
    makePlayer({ seat_number: 3 }),
    makePlayer({ seat_number: 1 }),
    makePlayer({ seat_number: 2 }),
  ];
  expect(getOccupiedSeats(players)).toEqual([1, 2, 3]);
});

test('ignora seats NaN ou não-numéricos', () => {
  const players = [
    makePlayer({ seat_number: 1 }),
    makePlayer({ seat_number: NaN }),
    { ...makePlayer(), seat_number: '2' },
  ];
  expect(getOccupiedSeats(players)).toEqual([1]);
});

test('retorna array vazio para lista vazia', () => {
  expect(getOccupiedSeats([])).toEqual([]);
});

test('deduplica assentos repetidos', () => {
  const players = [
    makePlayer({ seat_number: 1 }),
    makePlayer({ seat_number: 1 }),
  ];
  expect(getOccupiedSeats(players)).toEqual([1]);
});

suite('turn.js — getActiveSeats');

test('exclui jogadores com fold', () => {
  const players = [
    makePlayer({ seat_number: 1, folded: false, chips: 100 }),
    makePlayer({ seat_number: 2, folded: true,  chips: 100 }),
  ];
  expect(getActiveSeats(players)).toEqual([1]);
});

test('exclui jogadores sem fichas (all-in com 0)', () => {
  const players = [
    makePlayer({ seat_number: 1, chips: 100 }),
    makePlayer({ seat_number: 2, chips: 0 }),
  ];
  expect(getActiveSeats(players)).toEqual([1]);
});

test('inclui todos se ninguém desistiu nem está zerado', () => {
  const players = [
    makePlayer({ seat_number: 1, chips: 100 }),
    makePlayer({ seat_number: 2, chips: 50 }),
    makePlayer({ seat_number: 3, chips: 200 }),
  ];
  expect(getActiveSeats(players)).toEqual([1, 2, 3]);
});

suite('turn.js — nextSeatInRing');

test('avança para o próximo assento normalmente', () => {
  expect(nextSeatInRing([1, 2, 3], 1)).toBe(2);
  expect(nextSeatInRing([1, 2, 3], 2)).toBe(3);
});

test('rotaciona do último para o primeiro (anel circular)', () => {
  expect(nextSeatInRing([1, 2, 3], 3)).toBe(1);
});

test('retorna null para lista vazia', () => {
  expect(nextSeatInRing([], 1)).toBeNull();
});

test('retorna o único elemento para lista com 1 item', () => {
  expect(nextSeatInRing([5], 5)).toBe(5);
});

test('fromSeat não existente — busca o próximo maior', () => {
  expect(nextSeatInRing([1, 2, 5], 4)).toBe(5);
});

test('fromSeat maior que todos — volta pro início', () => {
  expect(nextSeatInRing([1, 2, 3], 99)).toBe(1);
});

suite('turn.js — computeNextDealerSeat');

test('primeira mão (null) — dealer no menor assento', () => {
  expect(computeNextDealerSeat([1, 2, 3], null)).toBe(1);
});

test('passa o dealer para o próximo assento', () => {
  expect(computeNextDealerSeat([1, 2, 3], 1)).toBe(2);
  expect(computeNextDealerSeat([1, 2, 3], 3)).toBe(1);
});

test('retorna null para mesa vazia', () => {
  expect(computeNextDealerSeat([], null)).toBeNull();
});

suite('turn.js — computeBlindSeats (3+ jogadores)');

test('3 jogadores: SB à esquerda do Dealer, BB ao lado, ação ao lado do BB', () => {
  const result = computeBlindSeats([1, 2, 3], 1);
  expect(result.smallBlindSeat).toBe(2);
  expect(result.bigBlindSeat).toBe(3);
  expect(result.firstToActSeat).toBe(1);
});

test('rotação circular: dealer=3', () => {
  const result = computeBlindSeats([1, 2, 3], 3);
  expect(result.smallBlindSeat).toBe(1);
  expect(result.bigBlindSeat).toBe(2);
  expect(result.firstToActSeat).toBe(3);
});

suite('turn.js — computeBlindSeats heads-up (2 jogadores)');

test('heads-up: Dealer é o SB e age primeiro', () => {
  const result = computeBlindSeats([1, 2], 1);
  expect(result.smallBlindSeat).toBe(1);
  expect(result.bigBlindSeat).toBe(2);
  expect(result.firstToActSeat).toBe(1);
});

suite('turn.js — getNextTurnSeat');

test('retorna próximo ativo depois do assento atual', () => {
  expect(getNextTurnSeat([1, 2, 3], [1, 2, 3], 1)).toBe(2);
});

test('pula assentos com fold ou sem fichas', () => {
  expect(getNextTurnSeat([1, 2, 3], [1, 3], 1)).toBe(3);
});

test('retorna null se não houver ativos', () => {
  expect(getNextTurnSeat([1, 2, 3], [], 1)).toBeNull();
});

test('com 1 ativo, retorna ele mesmo', () => {
  expect(getNextTurnSeat([1, 2, 3], [2], 1)).toBe(2);
});

// ===========================================================
// GRUPO 4 — betting.js
// ===========================================================

suite('betting.js — getAmountToCall');

test('jogador não apostou nada: precisa cobrir o teto inteiro', () => {
  expect(getAmountToCall(0, 100)).toBe(100);
});

test('jogador já está no teto: retorna 0', () => {
  expect(getAmountToCall(100, 100)).toBe(0);
});

test('jogador apostou mais que o teto: retorna 0', () => {
  expect(getAmountToCall(200, 100)).toBe(0);
});

test('diferença parcial', () => {
  expect(getAmountToCall(50, 100)).toBe(50);
});

suite('betting.js — validateBetAmount');

test('aposta de zero é inválida', () => {
  expect(validateBetAmount(0, 500, 0, 100).valid).toBeFalsy();
});

test('aposta acima do saldo é inválida', () => {
  expect(validateBetAmount(600, 500, 0, 100).valid).toBeFalsy();
});

test('aposta menor que o necessário para cobrir é inválida', () => {
  expect(validateBetAmount(30, 500, 0, 100).valid).toBeFalsy();
});

test('aposta que cobre exatamente o teto é válida', () => {
  expect(validateBetAmount(100, 500, 0, 100).valid).toBeTruthy();
});

test('all-in com saldo abaixo do teto é válido (all-in curto)', () => {
  expect(validateBetAmount(40, 40, 0, 100).valid).toBeTruthy();
});

test('raise acima do teto é válido', () => {
  expect(validateBetAmount(200, 500, 0, 100).valid).toBeTruthy();
});

// ===========================================================
// GRUPO 5 — betting-round.js
// ===========================================================

suite('betting-round.js — getTableMaxBet');

test('retorna 0 se ninguém apostou', () => {
  const players = [makePlayer({ current_bet: 0 }), makePlayer({ current_bet: 0 })];
  expect(getTableMaxBet(players)).toBe(0);
});

test('retorna a maior aposta entre os não-foldados', () => {
  const players = [
    makePlayer({ current_bet: 50,  folded: false }),
    makePlayer({ current_bet: 100, folded: false }),
    makePlayer({ current_bet: 200, folded: true }),
  ];
  expect(getTableMaxBet(players)).toBe(100);
});

suite('betting-round.js — isReopeningAction');

test('aposta maior que o teto reabre a rodada', () => {
  expect(isReopeningAction(150, 100)).toBeTruthy();
});

test('aposta igual ao teto NÃO reabre (Call)', () => {
  expect(isReopeningAction(100, 100)).toBeFalsy();
});

test('aposta menor que o teto NÃO reabre (all-in curto)', () => {
  expect(isReopeningAction(60, 100)).toBeFalsy();
});

suite('betting-round.js — applyActionToRound');

test('quem agiu tem has_acted_this_round = true', () => {
  const p1 = makePlayer({ id: 'p1', current_bet: 0, chips: 500 });
  const p2 = makePlayer({ id: 'p2', current_bet: 0, chips: 500 });
  const updated = applyActionToRound([p1, p2], 'p1', 100, 0);
  const actingPlayer = updated.find(p => p.id === 'p1');
  expect(actingPlayer.has_acted_this_round).toBeTruthy();
});

test('raise reabre has_acted_this_round para os outros', () => {
  const p1 = makePlayer({ id: 'p1', current_bet: 100, chips: 500, has_acted_this_round: true });
  const p2 = makePlayer({ id: 'p2', current_bet: 0,   chips: 500, has_acted_this_round: false });
  const updated = applyActionToRound([p1, p2], 'p2', 200, 100);
  const p1After = updated.find(p => p.id === 'p1');
  expect(p1After.has_acted_this_round).toBeFalsy();
});

test('call NÃO reabre para os outros', () => {
  const p1 = makePlayer({ id: 'p1', current_bet: 100, chips: 500, has_acted_this_round: true });
  const p2 = makePlayer({ id: 'p2', current_bet: 0,   chips: 500, has_acted_this_round: false });
  const updated = applyActionToRound([p1, p2], 'p2', 100, 100);
  const p1After = updated.find(p => p.id === 'p1');
  expect(p1After.has_acted_this_round).toBeTruthy();
});

suite('betting-round.js — isBettingRoundClosed');

test('rodada fechada: todos igualaram e agiram', () => {
  const players = [
    makePlayer({ current_bet: 100, chips: 400, folded: false, has_acted_this_round: true }),
    makePlayer({ current_bet: 100, chips: 400, folded: false, has_acted_this_round: true }),
  ];
  expect(isBettingRoundClosed(players, 100)).toBeTruthy();
});

test('rodada aberta: alguém não agiu ainda', () => {
  const players = [
    makePlayer({ current_bet: 100, chips: 400, folded: false, has_acted_this_round: true }),
    makePlayer({ current_bet: 0,   chips: 500, folded: false, has_acted_this_round: false }),
  ];
  expect(isBettingRoundClosed(players, 100)).toBeFalsy();
});

test('rodada aberta: alguém não cobriu o teto', () => {
  const players = [
    makePlayer({ current_bet: 100, chips: 400, folded: false, has_acted_this_round: true }),
    makePlayer({ current_bet: 50,  chips: 450, folded: false, has_acted_this_round: true }),
  ];
  expect(isBettingRoundClosed(players, 100)).toBeFalsy();
});

test('todos foldados → rodada fechada', () => {
  const players = [
    makePlayer({ current_bet: 100, chips: 400, folded: true }),
    makePlayer({ current_bet: 100, chips: 400, folded: true }),
  ];
  expect(isBettingRoundClosed(players, 100)).toBeTruthy();
});

suite('betting-round.js — getNextSeatToAct');

test('retorna o próximo assento que ainda precisa agir', () => {
  const p1 = makePlayer({ id: 'p1', seat_number: 1, chips: 500, current_bet: 100, folded: false, has_acted_this_round: true });
  const p2 = makePlayer({ id: 'p2', seat_number: 2, chips: 500, current_bet: 0,   folded: false, has_acted_this_round: false });
  const p3 = makePlayer({ id: 'p3', seat_number: 3, chips: 500, current_bet: 100, folded: false, has_acted_this_round: true });
  expect(getNextSeatToAct([1, 2, 3], [p1, p2, p3], 100, 1)).toBe(2);
});

test('retorna null se ninguém mais precisa agir', () => {
  const p1 = makePlayer({ id: 'p1', seat_number: 1, chips: 400, current_bet: 100, folded: false, has_acted_this_round: true });
  const p2 = makePlayer({ id: 'p2', seat_number: 2, chips: 400, current_bet: 100, folded: false, has_acted_this_round: true });
  expect(getNextSeatToAct([1, 2], [p1, p2], 100, 2)).toBeNull();
});

// ===========================================================
// GRUPO 6 — pots.js
// ===========================================================

suite('pots.js — computeSidePots (sem all-in)');

test('um único pote quando todos apostaram o mesmo valor', () => {
  const contribs = [
    { id: 'p1', bet: 100, folded: false },
    { id: 'p2', bet: 100, folded: false },
    { id: 'p3', bet: 100, folded: false },
  ];
  const result = computeSidePots(contribs);
  expect(result.pots).toHaveLength(1);
  expect(result.pots[0].amount).toBe(300);
  expect(result.autoAwards).toHaveLength(0);
});

test('quem desistiu contribuiu mas não pode ganhar → autoAward', () => {
  const contribs = [
    { id: 'p1', bet: 100, folded: true  },
    { id: 'p2', bet: 100, folded: false },
  ];
  const result = computeSidePots(contribs);
  expect(result.pots).toHaveLength(0);
  expect(result.autoAwards[0].playerId).toBe('p2');
  expect(result.autoAwards[0].amount).toBe(200);
});

suite('pots.js — computeSidePots (com all-in desproporcional)');

test('all-in curto gera pote disputável + devolução automática do excedente', () => {
  const contribs = [
    { id: 'A', bet: 60,  folded: false },
    { id: 'B', bet: 100, folded: false },
  ];
  const result = computeSidePots(contribs);
  expect(result.pots).toHaveLength(1);
  expect(result.pots[0].amount).toBe(120);
  expect(result.autoAwards[0].playerId).toBe('B');
  expect(result.autoAwards[0].amount).toBe(40);
});

test('sumAllMoney nunca perde nem duplica dinheiro', () => {
  const contribs = [
    { id: 'A', bet: 60,  folded: false },
    { id: 'B', bet: 100, folded: false },
    { id: 'C', bet: 100, folded: true  },
  ];
  const totalIn = contribs.reduce((s, c) => s + c.bet, 0);
  expect(sumAllMoney(computeSidePots(contribs))).toBe(totalIn);
});

suite('pots.js — splitPotAmongWinners');

test('divisão igualitária sem resto', () => {
  const awards = splitPotAmongWinners(200, ['p1', 'p2']);
  expect(awards[0].amount).toBe(100);
  expect(awards[1].amount).toBe(100);
});

test('resto vai para o primeiro vencedor', () => {
  const awards = splitPotAmongWinners(100, ['p1', 'p2', 'p3']);
  expect(awards[0].amount).toBe(34);
  expect(awards[1].amount).toBe(33);
  expect(awards[2].amount).toBe(33);
});

test('total distribuído bate com o pote', () => {
  const total = 777;
  const awards = splitPotAmongWinners(total, ['p1', 'p2', 'p3']);
  const sum = awards.reduce((s, a) => s + a.amount, 0);
  expect(sum).toBe(total);
});

test('lista vazia retorna array vazio', () => {
  expect(splitPotAmongWinners(200, [])).toHaveLength(0);
});

// ===========================================================
// GRUPO 7 — win-condition.js
// ===========================================================

suite('win-condition.js — evaluateWinCondition (elimination)');

const eliminationRoom = { win_condition: 'elimination', round_limit: null, current_round: 5 };

test('termina quando sobra 1 jogador', () => {
  const players = [
    makePlayer({ is_eliminated: false }),
    makePlayer({ is_eliminated: true }),
  ];
  expect(evaluateWinCondition(players, eliminationRoom).finished).toBeTruthy();
});

test('NÃO termina com 2 vivos', () => {
  const players = [
    makePlayer({ is_eliminated: false }),
    makePlayer({ is_eliminated: false }),
  ];
  expect(evaluateWinCondition(players, eliminationRoom).finished).toBeFalsy();
});

test('termina se 0 sobreviventes (todos eliminados)', () => {
  const players = [
    makePlayer({ is_eliminated: true }),
    makePlayer({ is_eliminated: true }),
  ];
  expect(evaluateWinCondition(players, eliminationRoom).finished).toBeTruthy();
});

suite('win-condition.js — evaluateWinCondition (round_limit)');

test('termina quando current_round >= round_limit', () => {
  const room = { win_condition: 'round_limit', round_limit: 10, current_round: 10 };
  expect(evaluateWinCondition([], room).finished).toBeTruthy();
});

test('NÃO termina antes do limite', () => {
  const room = { win_condition: 'round_limit', round_limit: 10, current_round: 9 };
  expect(evaluateWinCondition([], room).finished).toBeFalsy();
});

suite('win-condition.js — buildFinalResults');

test('modo round_limit: ordena por fichas (maior = rank 1)', () => {
  const players = [
    makePlayer({ id: 'p1', name: 'Ana',   chips: 500,  is_eliminated: false }),
    makePlayer({ id: 'p2', name: 'Bob',   chips: 1500, is_eliminated: false }),
    makePlayer({ id: 'p3', name: 'Carol', chips: 750,  is_eliminated: false }),
  ];
  const results = buildFinalResults(players, 'round_limit');
  expect(results[0].name).toBe('Bob');
  expect(results[0].rank).toBe(1);
});

test('modo elimination: sobrevivente fica em 1º', () => {
  const players = [
    makePlayer({ id: 'p1', name: 'Vivo',  chips: 2000, is_eliminated: false }),
    makePlayer({ id: 'p2', name: 'Morto', chips: 0,    is_eliminated: true, eliminated_at: new Date().toISOString() }),
  ];
  const results = buildFinalResults(players, 'elimination');
  expect(results[0].name).toBe('Vivo');
  expect(results[0].rank).toBe(1);
});

// ===========================================================
// GRUPO 8 — presence.js
// ===========================================================

suite('presence.js — getAfkRemainingMs / isPlayerAfk');

test('retorna 0 se lastSeenAt for null', () => {
  expect(getAfkRemainingMs(null, Date.now())).toBe(0);
});

test('jogador ativo recentemente NÃO está AFK', () => {
  const now = Date.now();
  const lastSeen = new Date(now - 5000).toISOString();
  expect(isPlayerAfk(lastSeen, now)).toBeFalsy();
});

test('jogador ausente pelo tempo do threshold ESTÁ AFK', () => {
  const now = Date.now();
  const lastSeen = new Date(now - AFK_KICK_THRESHOLD_MS - 1).toISOString();
  expect(isPlayerAfk(lastSeen, now)).toBeTruthy();
});

test('tempo restante nunca é negativo', () => {
  const now = Date.now();
  const lastSeen = new Date(now - AFK_KICK_THRESHOLD_MS - 60000).toISOString();
  expect(getAfkRemainingMs(lastSeen, now)).toBe(0);
});

suite('presence.js — shouldShowAfkWarning');

test('não mostra aviso para jogador recente', () => {
  const now = Date.now();
  const lastSeen = new Date(now - 1000).toISOString();
  expect(shouldShowAfkWarning(lastSeen, now)).toBeFalsy();
});

test('mostra aviso depois do threshold de aviso', () => {
  const now = Date.now();
  const lastSeen = new Date(now - AFK_WARNING_THRESHOLD_MS - 1).toISOString();
  expect(shouldShowAfkWarning(lastSeen, now)).toBeTruthy();
});

test('não mostra aviso se lastSeenAt for null', () => {
  expect(shouldShowAfkWarning(null, Date.now())).toBeFalsy();
});

suite('presence.js — formatCountdown');

test('formata 150000ms como "2:30"', () => {
  expect(formatCountdown(150000)).toBe('2:30');
});

test('formata 65000ms como "1:05"', () => {
  expect(formatCountdown(65000)).toBe('1:05');
});

test('formata 0ms como "0:00"', () => {
  expect(formatCountdown(0)).toBe('0:00');
});

test('formata 1000ms como "0:01"', () => {
  expect(formatCountdown(1000)).toBe('0:01');
});

suite('presence.js — computeNextHostByJoinOrder');

test('escolhe jogador não-AFK mais antigo', () => {
  const now = Date.now();
  const recentSeen = new Date(now - 1000).toISOString();
  const players = [
    makePlayer({ id: 'old', joined_at: new Date(now - 60000).toISOString(), last_seen_at: recentSeen }),
    makePlayer({ id: 'new', joined_at: new Date(now - 10000).toISOString(), last_seen_at: recentSeen }),
  ];
  expect(computeNextHostByJoinOrder(players, now, 'host')).toBe('old');
});

test('exclui o excludePlayerId', () => {
  const now = Date.now();
  const recentSeen = new Date(now - 1000).toISOString();
  const players = [
    makePlayer({ id: 'p1', joined_at: new Date(now - 60000).toISOString(), last_seen_at: recentSeen }),
    makePlayer({ id: 'p2', joined_at: new Date(now - 10000).toISOString(), last_seen_at: recentSeen }),
  ];
  expect(computeNextHostByJoinOrder(players, now, 'p1')).toBe('p2');
});

test('retorna null se todos estão AFK', () => {
  const now = Date.now();
  const afkSeen = new Date(now - AFK_KICK_THRESHOLD_MS - 1).toISOString();
  const players = [
    makePlayer({ id: 'p1', joined_at: new Date(now - 60000).toISOString(), last_seen_at: afkSeen }),
  ];
  expect(computeNextHostByJoinOrder(players, now, 'host')).toBeNull();
});

// ===========================================================
// CENÁRIO DE JOGO COMPLETO: partida de 3 jogadores
// ===========================================================

suite('🎲 Cenário integrado — partida de 3 jogadores');

test('rotação do dealer ao longo de 3 mãos', () => {
  const seats = [1, 2, 3];
  const d1 = computeNextDealerSeat(seats, null);
  const d2 = computeNextDealerSeat(seats, d1);
  const d3 = computeNextDealerSeat(seats, d2);
  const d4 = computeNextDealerSeat(seats, d3);
  expect(d1).toBe(1);
  expect(d2).toBe(2);
  expect(d3).toBe(3);
  expect(d4).toBe(1);
});

test('ciclo completo: call → call → rodada fecha', () => {
  let players = [
    makePlayer({ id: 'p1', seat_number: 1, chips: 400, current_bet: 100, folded: false, has_acted_this_round: true }),
    makePlayer({ id: 'p2', seat_number: 2, chips: 400, current_bet: 0,   folded: false, has_acted_this_round: false }),
    makePlayer({ id: 'p3', seat_number: 3, chips: 400, current_bet: 0,   folded: false, has_acted_this_round: false }),
  ];
  players = applyActionToRound(players, 'p2', 100, 100);
  expect(isBettingRoundClosed(players, 100)).toBeFalsy();
  players = applyActionToRound(players, 'p3', 100, 100);
  expect(isBettingRoundClosed(players, 100)).toBeTruthy();
});

test('raise reabre a decisão e fecha quando todos respondem', () => {
  let players = [
    makePlayer({ id: 'p1', seat_number: 1, chips: 400, current_bet: 100, folded: false, has_acted_this_round: true }),
    makePlayer({ id: 'p2', seat_number: 2, chips: 400, current_bet: 100, folded: false, has_acted_this_round: true }),
  ];
  players = applyActionToRound(players, 'p2', 200, 100);
  expect(isBettingRoundClosed(players, 200)).toBeFalsy();
  players = applyActionToRound(players, 'p1', 200, 200);
  expect(isBettingRoundClosed(players, 200)).toBeTruthy();
});

test('pote total nunca perde dinheiro em jogo com all-in', () => {
  const contribs = [
    { id: 'Ana',   bet: 200, folded: false },
    { id: 'Bob',   bet: 200, folded: false },
    { id: 'Carol', bet: 100, folded: true  },
  ];
  const totalIn = contribs.reduce((s, c) => s + c.bet, 0);
  expect(sumAllMoney(computeSidePots(contribs))).toBe(totalIn);
});

// ===========================================================
// Relatório final
// ===========================================================

const total = passed + failed;
console.log('\n' + '═'.repeat(50));
if (failed === 0) {
  console.log(`\x1b[32m✅  ${passed}/${total} testes passaram — tudo OK!\x1b[0m`);
} else {
  console.log(`\x1b[31m❌  ${failed}/${total} testes FALHARAM\x1b[0m`);
  console.log(`\x1b[32m    ${passed}/${total} passaram\x1b[0m`);
  process.exit(1);
}
console.log('═'.repeat(50) + '\n');
