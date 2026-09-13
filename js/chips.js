// ===========================================================
// GhostStackPoker — js/chips.js
//
// MUDANÇA DE ARQUITETURA: este arquivo deixou de representar uma
// "carteira física de fichas" (quantidade de cada cor que o jogador
// possui). Isso foi abandonado de propósito — era a origem de uma
// cadeia inteira de bugs (distribuição, reconstrução, sincronização).
//
// A partir de agora, a fonte da verdade é o SALDO do jogador
// (players.chips, um número — dinheiro, não fichas físicas) e a
// APOSTA ATUAL (um acumulador simples, current_bet). As "fichas" que
// aparecem na tela são só BOTÕES de incremento visual: clicar numa
// ficha de 20 soma 20 na aposta atual. Não existe mais "quantas fichas
// de 20 o jogador tem" — só existe "quanto dinheiro ele tem".
//
// Por isso este arquivo agora só exporta:
// - os valores fixos de cada botão (CHIP_VALUES);
// - o formatador de dinheiro (formatMoney).
// Nenhuma função de distribuir/reconstruir/somar fichas existe mais.
// ===========================================================

// Valor de cada botão de ficha — fixo, não configurável pelo Host
// (a "Configuração Avançada de Fichas" foi removida: o Host só define
// o Saldo Inicial agora, em host-config.html).
export const CHIP_VALUES = {
  preta: 5,
  azul: 10,
  vermelha: 20,
  verde: 50,
  branca: 100,
  amarela: 200
};

// Formata número como "1.000" (separador brasileiro).
export function formatMoney(value) {
  return value.toLocaleString('pt-BR');
}
