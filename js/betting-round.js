// ===========================================================
// GhostStackPoker — js/betting-round.js
// Motor de FECHAMENTO da rodada de apostas — complementa js/turn.js
// (que só sabe de posição: assentos, Dealer, Small/Big Blind).
//
// SEPARAÇÃO DELIBERADA:
//   js/turn.js       -> POSIÇÃO na mesa ("quem senta depois de quem")
//   js/betting-round.js -> DIREITO/NECESSIDADE de agir ("quem ainda
//                          precisa decidir algo nesta rodada de apostas")
//
// Isso existe porque "próximo assento ativo" (getNextTurnSeat, em
// turn.js) NÃO é suficiente sozinho: ele não sabe se aquele jogador já
// igualou a maior aposta E já teve a chance de responder ao último
// aumento. Sem essa distinção, o turno podia "voltar" pra alguém que
// já tinha agido, ou nunca fechar (bug do "jogador 1 espera jogador 2,
// jogador 2 espera jogador 1").
//
// Nenhuma função aqui toca no DOM ou no Supabase — só recebem arrays
// de jogadores (com seat_number, folded, chips, current_bet,
// has_acted_this_round) e devolvem um veredito ou o próximo assento.
// ===========================================================

import { nextSeatInRing } from './turn.js';

// Jogadores que AINDA fazem parte da decisão desta rodada: não
// desistiram e ainda têm fichas (quem está all-in, chips=0, não
// decide mais nada, só espera o resultado).
function getStillDecidingPlayers(players) {
  return players.filter(function (p) { return !p.folded && p.chips > 0; });
}

// Maior aposta atual da mesa entre quem não desistiu (all-in inclusive
// — a contribuição dele ainda conta pra saber o teto da rodada).
export function getTableMaxBet(players) {
  return players.reduce(function (max, p) {
    return (!p.folded && p.current_bet > max) ? p.current_bet : max;
  }, 0);
}

// Uma ação "reabre" a rodada (obriga todo mundo a agir de novo) quando
// ela aumenta o teto da mesa — um Raise normal, ou um All-in que por
// acaso supera o teto anterior. Um Call (iguala sem superar) ou um
// All-in "curto" (menor que o teto) NÃO reabrem nada.
export function isReopeningAction(newActingBet, previousMaxBet) {
  return newActingBet > previousMaxBet;
}

// Aplica os efeitos de UMA ação sobre o estado "já agiu nesta rodada"
// de todos os jogadores. NÃO muta o array recebido — devolve um novo.
//
// - players: array de jogadores ANTES da ação (com has_acted_this_round)
// - actingPlayerId: quem agiu
// - newActingBet: o current_bet dele DEPOIS da ação
// - previousMaxBet: o teto da mesa ANTES desta ação
export function applyActionToRound(players, actingPlayerId, newActingBet, previousMaxBet) {
  const reopens = isReopeningAction(newActingBet, previousMaxBet);

  return players.map(function (p) {
    if (p.id === actingPlayerId) {
      return Object.assign({}, p, { current_bet: newActingBet, has_acted_this_round: true });
    }
    // Um aumento reabre a decisão pra todo mundo que ainda está na mão
    // e ainda tem fichas — quem já desistiu ou já está all-in não tem
    // mais nada a decidir, então não faz sentido "reabrir" pra eles.
    if (reopens && !p.folded && p.chips > 0) {
      return Object.assign({}, p, { has_acted_this_round: false });
    }
    return p;
  });
}

// A rodada de apostas está FECHADA quando todo mundo que ainda decide
// algo (não desistiu, tem fichas) já igualou a maior aposta da mesa E
// já teve a chance de agir desde o último aumento. Um array vazio
// (todo mundo desistiu ou está all-in) também conta como fechada —
// não sobrou ninguém pra decidir mais nada.
export function isBettingRoundClosed(players, tableMaxBet) {
  const stillDeciding = getStillDecidingPlayers(players);
  return stillDeciding.every(function (p) {
    return p.current_bet === tableMaxBet && p.has_acted_this_round === true;
  });
}

// Acha o próximo assento que AINDA precisa agir — anda pela roda dos
// assentos OCUPADOS (referência de posição estável, vem de turn.js),
// mas só "para" em alguém que realmente ainda precisa decidir algo
// (não desistiu, tem fichas, e (não igualou a mesa OU não agiu desde
// o último aumento)). Devolve null se ninguém mais precisa agir — é
// assim que o motor sabe que deve fechar a rodada.
export function getNextSeatToAct(occupiedSeats, players, tableMaxBet, fromSeat) {
  const needsToAct = new Set(
    players
      .filter(function (p) {
        return !p.folded && p.chips > 0 && (p.current_bet < tableMaxBet || !p.has_acted_this_round);
      })
      .map(function (p) { return p.seat_number; })
  );

  if (needsToAct.size === 0) return null;

  let candidate = fromSeat;
  for (let i = 0; i < occupiedSeats.length; i++) {
    candidate = nextSeatInRing(occupiedSeats, candidate);
    if (candidate === null) return null;
    if (needsToAct.has(candidate)) return candidate;
  }
  return null;
}
