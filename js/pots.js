// ===========================================================
// GhostStackPoker — js/pots.js (Fase 5 — reescrito por completo)
// Matemática de Side Pots. Nenhuma função aqui toca no DOM ou no
// Supabase — só recebem uma lista de contribuições da mão atual e
// devolvem os potes já calculados.
//
// REGRA DE OURO (do Plano Mestre): não confundir NÍVEL MATEMÁTICO DE
// CONTRIBUIÇÃO com POTE REAL QUE PRECISA SER DISPUTADO. Primeiro
// calculamos as camadas de contribuição; depois decidimos quais delas
// são realmente disputáveis (2+ jogadores elegíveis) e quais são só
// dinheiro "sem adversário" — que a regra oficial do poker devolve
// direto pra quem colocou (uncalled bet), sem virar pote nenhum.
//
// Exemplo do documento (2 jogadores): A vai all-in com 100, B tem 200
// e cobre com 200. NÃO existe "Pote 1 = 200, Pote 2 = 100" com dois
// vencedores pra escolher — só existe UM pote disputável (200) e um
// excedente de 100 que volta pro B automaticamente, porque não tem
// mais ninguém pra disputar aquele pedaço.
// ===========================================================

// contributions: [{ id, bet, folded }, ...] — "bet" é quanto cada
// jogador colocou na mão inteira (current_bet acumulado), incluindo
// quem já desistiu (o dinheiro dele continua valendo, só que ele não
// pode mais GANHAR nenhum pote).
//
// Devolve:
//   {
//     pots: [{ amount, eligible_player_ids }, ...],   <- precisam de
//                                                          decisão do Host
//     autoAwards: [{ playerId, amount }, ...]          <- já resolvidos
//                                                          sozinhos, sem
//                                                          pedir nada pro
//                                                          Host (excedente
//                                                          devolvido, ou
//                                                          só sobrou 1
//                                                          elegível)
//   }
export function computeSidePots(contributions) {
  const contributors = contributions.filter(function (c) { return c.bet > 0; });
  if (contributors.length === 0) return { pots: [], autoAwards: [] };

  const levels = Array.from(new Set(contributors.map(function (c) { return c.bet; })))
    .sort(function (a, b) { return a - b; });

  const pots = [];
  const autoAwards = [];
  let previousLevel = 0;

  levels.forEach(function (level) {
    const layerSize = level - previousLevel;

    // Quem "paga" esta camada: todo mundo que apostou pelo menos este nível.
    const payingPlayers = contributors.filter(function (c) { return c.bet >= level; });
    const amount = layerSize * payingPlayers.length;

    if (amount > 0) {
      if (payingPlayers.length === 1) {
        // NINGUÉM MAIS chegou nesse nível — esse dinheiro nunca foi
        // "coberto" por ninguém. Regra oficial do poker: volta direto
        // pro próprio jogador (uncalled bet), sem virar pote.
        autoAwards.push({ playerId: payingPlayers[0].id, amount: amount });
      } else {
        const eligiblePlayerIds = payingPlayers
          .filter(function (c) { return !c.folded; })
          .map(function (c) { return c.id; });

        if (eligiblePlayerIds.length === 1) {
          // Várias pessoas contribuíram pra essa camada, mas todas
          // menos uma desistiram — não sobrou decisão real nenhuma
          // pro Host tomar, então resolve sozinho.
          autoAwards.push({ playerId: eligiblePlayerIds[0], amount: amount });
        } else if (eligiblePlayerIds.length === 0) {
          // Caso extremo (não deveria acontecer numa mão de verdade):
          // todo mundo que contribuiu pra essa camada desistiu. Pra
          // nunca "sumir" dinheiro, devolve proporcionalmente a quem
          // pagou, mesmo tendo desistido.
          const share = Math.floor(amount / payingPlayers.length);
          let distributed = 0;
          payingPlayers.forEach(function (p, index) {
            const isLast = index === payingPlayers.length - 1;
            const thisShare = isLast ? (amount - distributed) : share;
            distributed += thisShare;
            autoAwards.push({ playerId: p.id, amount: thisShare });
          });
        } else {
          // Disputa de verdade: 2 ou mais jogadores ainda elegíveis.
          pots.push({ amount: amount, eligible_player_ids: eligiblePlayerIds });
        }
      }
    }

    previousLevel = level;
  });

  return { pots: pots, autoAwards: autoAwards };
}

// Soma total de tudo (potes reais + devoluções automáticas) — deve
// sempre bater com a soma de todas as apostas da mão. Útil pra testar
// que nenhum dinheiro "sumiu" ou foi duplicado.
export function sumAllMoney(result) {
  const potsTotal = result.pots.reduce(function (total, pot) { return total + pot.amount; }, 0);
  const awardsTotal = result.autoAwards.reduce(function (total, a) { return total + a.amount; }, 0);
  return potsTotal + awardsTotal;
}

// Divide um pote entre múltiplos vencedores (EMPATE). Quando não dá
// pra dividir igualmente, o resto (sempre menor que a quantidade de
// vencedores) vai pro primeiro da lista — regra simples e
// determinística, só pra nunca "perder" nem "inventar" dinheiro.
export function splitPotAmongWinners(amount, winnerIds) {
  if (winnerIds.length === 0) return [];
  const share = Math.floor(amount / winnerIds.length);
  const remainder = amount - (share * winnerIds.length);
  return winnerIds.map(function (id, index) {
    return { playerId: id, amount: share + (index === 0 ? remainder : 0) };
  });
}
