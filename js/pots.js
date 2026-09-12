// ===========================================================
// GhostStackPoker — js/pots.js
// Matemática pura de Side Pots (potes secundários de all-in). Nenhuma
// função aqui toca no DOM ou no Supabase — só recebem uma lista de
// contribuições da mão atual e devolvem os potes já calculados.
//
// REGRA: quando um jogador vai all-in com menos fichas do que os
// outros apostaram, ele só concorre à fatia do pote proporcional ao
// que ele colocou. O excedente forma um pote separado, disputado só
// entre quem cobriu o valor mais alto.
//
// Exemplo do enunciado: A vai all-in com 10, B e C apostam 50 cada.
//   Pote principal: 10 × 3 jogadores = 30 (A, B e C disputam)
//   Pote secundário: (50-10) × 2 jogadores = 80 (só B e C disputam)
//   Total: 30 + 80 = 110 ✅ (bate com a soma das apostas: 10+50+50)
// ===========================================================

// contributions: [{ id, bet, folded }, ...] — "bet" é quanto cada
// jogador colocou na mão inteira (current_bet acumulado), incluindo
// quem já desistiu (o dinheiro dele continua valendo, só que ele não
// pode mais GANHAR nenhum pote).
//
// Devolve: [{ amount, eligible_player_ids }, ...] em ordem: pote
// principal primeiro, depois os secundários (do menor all-in pro maior).
export function computeSidePots(contributions) {
  const contributors = contributions.filter(function (c) { return c.bet > 0; });
  if (contributors.length === 0) return [];

  const levels = Array.from(new Set(contributors.map(function (c) { return c.bet; })))
    .sort(function (a, b) { return a - b; });

  const pots = [];
  let previousLevel = 0;

  levels.forEach(function (level) {
    const layerSize = level - previousLevel;

    // Quem "paga" esta camada: todo mundo que apostou pelo menos este nível.
    const payingPlayers = contributors.filter(function (c) { return c.bet >= level; });
    const potAmount = layerSize * payingPlayers.length;

    if (potAmount > 0) {
      // Quem pode GANHAR esta camada: dos que pagaram, só quem não desistiu.
      const eligiblePlayerIds = payingPlayers
        .filter(function (c) { return !c.folded; })
        .map(function (c) { return c.id; });

      pots.push({ amount: potAmount, eligible_player_ids: eligiblePlayerIds });
    }

    previousLevel = level;
  });

  return pots;
}

// Soma total de todos os potes — deve sempre bater com a soma de todas
// as apostas da mão (útil pra validar/testar).
export function sumPots(pots) {
  return pots.reduce(function (total, pot) { return total + pot.amount; }, 0);
}
