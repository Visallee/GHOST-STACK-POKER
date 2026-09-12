// ===========================================================
// GhostStackPoker — js/turn.js
// Funções puras de ordenação de turno: assentos fixos, rotação do
// botão do Dealer e cálculo de quem age primeiro em cada mão, seguindo
// as regras oficiais do poker (SB à esquerda do Dealer, BB à esquerda
// do SB, ação começa à esquerda do BB no pré-flop — com a exceção
// "heads-up", quando só restam 2 jogadores na mesa).
//
// Nenhuma função aqui toca no DOM ou no Supabase — só recebem e
// devolvem dados simples (arrays de números de assento, o array de
// jogadores do cache). Isso facilita testar e reusar em partida.js.
//
// LIMITAÇÃO CONHECIDA: estas funções assumem que a lista de jogadores
// não muda NO MEIO de uma mão (ninguém entra durante uma mão em
// andamento). Um jogador que entra com a mesa já em jogo é incluído na
// rotação de "assentos ativos" imediatamente — ele não fica "sentado
// fora" até a próxima mão. Se isso for um problema no seu grupo, dá
// pra adicionar uma flag "sitting_out" em players futuramente.
// ===========================================================

// Lista ordenada (crescente, sem repetição) dos assentos OCUPADOS por
// jogadores atualmente na sala — independe de terem desistido (fold)
// ou estarem sem fichas. Usada como "anel" estável para girar o Dealer
// e para saber a posição de referência de quem acabou de agir.
export function getOccupiedSeats(players) {
  const seats = players
    .map(function (p) { return p.seat_number; })
    .filter(function (n) { return typeof n === 'number' && !Number.isNaN(n); });
  return Array.from(new Set(seats)).sort(function (a, b) { return a - b; });
}

// Assentos que ainda podem AGIR nesta mão: não desistiram (fold) e
// ainda têm fichas (quem está all-in com 0 fichas é pulado
// automaticamente, assim como quem desistiu).
export function getActiveSeats(players) {
  return players
    .filter(function (p) { return !p.folded && p.chips > 0; })
    .map(function (p) { return p.seat_number; })
    .filter(function (n) { return typeof n === 'number' && !Number.isNaN(n); })
    .sort(function (a, b) { return a - b; });
}

// Dado um assento de referência, devolve o próximo assento na roda
// (circular) dentro da lista ORDENADA de assentos ocupados. Se
// "fromSeat" não existir mais na lista (ex: jogador foi expulso),
// usa a posição lógica onde ele "entraria" como referência, em vez de
// quebrar.
function nextSeatInRing(occupiedSeatsSorted, fromSeat) {
  const n = occupiedSeatsSorted.length;
  if (n === 0) return null;
  if (n === 1) return occupiedSeatsSorted[0];

  let idx = occupiedSeatsSorted.indexOf(fromSeat);
  if (idx === -1) {
    idx = occupiedSeatsSorted.findIndex(function (s) { return s > fromSeat; });
    if (idx === -1) return occupiedSeatsSorted[0]; // fromSeat era maior que todos — volta pro início
    return occupiedSeatsSorted[idx];
  }
  return occupiedSeatsSorted[(idx + 1) % n];
}

// Gira o botão do Dealer pro próximo assento ocupado. Na primeiríssima
// mão da sala (previousDealerSeat é null), o Dealer começa no assento
// de menor número.
export function computeNextDealerSeat(occupiedSeats, previousDealerSeat) {
  if (occupiedSeats.length === 0) return null;
  if (previousDealerSeat === null || previousDealerSeat === undefined) {
    return occupiedSeats[0];
  }
  return nextSeatInRing(occupiedSeats, previousDealerSeat);
}

// A partir do assento do Dealer, calcula Small Blind, Big Blind e quem
// age primeiro no pré-flop. Regra oficial: ação começa à esquerda do
// Big Blind. Exceção "heads-up" (só 2 jogadores): o próprio Dealer é o
// Small Blind e age primeiro no pré-flop.
export function computeBlindSeats(occupiedSeats, dealerSeat) {
  if (occupiedSeats.length === 0 || dealerSeat === null || dealerSeat === undefined) {
    return { smallBlindSeat: null, bigBlindSeat: null, firstToActSeat: null };
  }

  if (occupiedSeats.length === 1) {
    // Só sobrou um jogador ocupando a mesa — não há mão real a jogar.
    return { smallBlindSeat: dealerSeat, bigBlindSeat: dealerSeat, firstToActSeat: dealerSeat };
  }

  if (occupiedSeats.length === 2) {
    const bigBlindSeat = nextSeatInRing(occupiedSeats, dealerSeat);
    return { smallBlindSeat: dealerSeat, bigBlindSeat: bigBlindSeat, firstToActSeat: dealerSeat };
  }

  const smallBlindSeat = nextSeatInRing(occupiedSeats, dealerSeat);
  const bigBlindSeat = nextSeatInRing(occupiedSeats, smallBlindSeat);
  const firstToActSeat = nextSeatInRing(occupiedSeats, bigBlindSeat);
  return { smallBlindSeat: smallBlindSeat, bigBlindSeat: bigBlindSeat, firstToActSeat: firstToActSeat };
}

// Depois que alguém age, acha quem joga em seguida: anda pela roda dos
// assentos OCUPADOS (referência estável, não muda por fold/all-in),
// mas só "para" em assentos que ainda estão ATIVOS. Devolve o próprio
// assento se só restar 1 jogador ativo (a mão deveria terminar — quem
// decide isso é o Host, clicando em "Entregar Pote") e null se não
// restar nenhum.
export function getNextTurnSeat(occupiedSeats, activeSeats, fromSeat) {
  if (activeSeats.length === 0) return null;
  if (activeSeats.length === 1) return activeSeats[0];

  const activeSet = new Set(activeSeats);
  let candidate = fromSeat;

  for (let i = 0; i < occupiedSeats.length; i++) {
    candidate = nextSeatInRing(occupiedSeats, candidate);
    if (candidate === null) return null;
    if (activeSet.has(candidate)) return candidate;
  }
  return null;
}
