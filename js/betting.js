// ===========================================================
// GhostStackPoker — js/betting.js
// Funções puras da REGRA DE APOSTA MÍNIMA do poker: um jogador nunca
// pode confirmar uma aposta menor que o necessário para igualar a
// maior aposta da mesa — a única exceção é ir All-in com um saldo
// insuficiente pra cobrir (all-in "curto").
//
// Nenhuma função aqui toca no DOM ou no Supabase — só recebem números
// (saldo, quanto já apostou, maior aposta da mesa) e devolvem um
// veredito. Isso é usado tanto pela INTERFACE (desabilitar o botão de
// confirmar) quanto pela LÓGICA que processa a ação (nunca confia só
// na interface) — exatamente como pedido no plano mestre.
// ===========================================================

// Quanto este jogador ainda precisa colocar pra igualar a maior
// aposta da mesa (nunca é negativo — se ele já está igualado ou à
// frente, o valor é 0).
export function getAmountToCall(playerCurrentBet, tableMaxBet) {
  return Math.max(0, tableMaxBet - playerCurrentBet);
}

// Valida um valor de aposta (usado tanto por "Cobrir" quanto por
// "Confirmar Aumento"). "betAmount" é sempre o DELTA — quanto o
// jogador está adicionando AGORA, não o total acumulado na mão.
//
// Regras:
// - tem que ser > 0 (usar getAmountToCall()===0 pra saber se dá pra
//   simplesmente "passar" sem apostar nada — essa função não trata
//   apostas de valor zero, isso é decidido antes de chamar aqui);
// - não pode passar do saldo disponível;
// - se NÃO for um all-in (betAmount === saldo inteiro), o total
//   resultante (o que já tinha + o que está adicionando) tem que
//   alcançar pelo menos a maior aposta da mesa.
//
// Devolve { valid: true } ou { valid: false, reason: '...' }.
export function validateBetAmount(betAmount, playerBalance, playerCurrentBet, tableMaxBet) {
  if (betAmount <= 0) {
    return { valid: false, reason: 'A aposta precisa ser maior que zero.' };
  }
  if (betAmount > playerBalance) {
    return { valid: false, reason: 'Saldo insuficiente para essa aposta.' };
  }

  const isAllIn = betAmount === playerBalance;
  if (isAllIn) {
    // All-in é sempre válido, mesmo que não cubra a aposta da mesa
    // inteira (all-in "curto" — regra oficial do poker).
    return { valid: true };
  }

  const amountToCall = getAmountToCall(playerCurrentBet, tableMaxBet);
  if (betAmount < amountToCall) {
    return {
      valid: false,
      reason: 'Você precisa colocar pelo menos ' + amountToCall + ' para cobrir a aposta atual (ou ir All-in).'
    };
  }

  return { valid: true };
}
