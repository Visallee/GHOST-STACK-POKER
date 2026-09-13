// ===========================================================
// GhostStackPoker — js/chips.js
// Regras das fichas: valores, distribuição inicial e funções puras
// (sem tocar no DOM nem no Supabase). Só js/partida.js usa isso hoje,
// mas fica isolado aqui pra facilitar teste e reuso.
// ===========================================================

// Distribuição inicial oficial: soma exatamente 1000.
// 20 pretas (5) + 10 azuis (10) + 10 vermelhas (20) + 4 verdes (50)
// + 2 brancas (100) + 1 amarela (200) = 1000
export const initialChipCounts = {
  preta: 20,
  azul: 10,
  vermelha: 10,
  verde: 4,
  branca: 2,
  amarela: 1
};

// Valor em fichas de cada cor.
export const chipValues = {
  preta: 5,
  azul: 10,
  vermelha: 20,
  verde: 50,
  branca: 100,
  amarela: 200
};

// Soma o valor total de um objeto de contagem de fichas (ex: {preta: 20, ...}).
export function calculateStackTotal(counts) {
  let total = 0;
  for (const color in counts) {
    total += counts[color] * chipValues[color];
  }
  return total;
}

// Formata número como "1.000" (separador brasileiro).
export function formatMoney(value) {
  return value.toLocaleString('pt-BR');
}

// Dado um objeto de contagem de fichas (mutado por referência) e um valor em
// dinheiro que precisa ser "criado" (ex: o jogador ganhou o pote), distribui
// esse valor em fichas, começando pela maior nota (amarela) até a menor.
//
// "valuesMap" é opcional: se a sala tiver valores customizados pelo Host
// (rooms.chip_values), passe eles aqui — caso contrário usa os padrões.
export function addChipsFromAmount(counts, amount, valuesMap) {
  const values = valuesMap || chipValues;
  const order = ['amarela', 'branca', 'verde', 'vermelha', 'azul', 'preta'];
  let remaining = amount;
  order.forEach(function (color) {
    const val = values[color];
    if (!val || val <= 0) return;
    const count = Math.floor(remaining / val);
    if (count > 0) {
      counts[color] += count;
      remaining -= count * val;
    }
  });
}

// Reconstrói do zero um objeto de contagem de fichas que soma exatamente
// ao valor informado — como um caixa dando troco, sempre a partir do
// maior valor. Diferente de addChipsFromAmount/removeChipsForAmount
// (que ajustam um objeto EXISTENTE aos poucos, acumulando erro se o
// objeto de origem já estiver errado), esta função nunca herda estado
// anterior: o resultado depende só do "total" recebido.
export function buildChipCountsForTotal(total, valuesMap) {
  const counts = { preta: 0, azul: 0, vermelha: 0, verde: 0, branca: 0, amarela: 0 };
  addChipsFromAmount(counts, total, valuesMap);
  return counts;
}

// Dado um objeto de contagem de fichas (mutado por referência) e um valor em
// dinheiro que precisa "sair" (ex: pagou o ante), remove fichas suficientes,
// começando pela menor nota (preta) até a maior.
// NOTA: partida.js não usa mais esta função para "reconciliar" o saldo do
// jogador com o banco — foi exatamente esse padrão (ajustar aos poucos um
// valor que já podia estar errado) que causava o bug de dessincronização.
// Ela continua aqui como utilidade genérica, caso seja útil no futuro
// (ex: visualização de fichas retiradas do pote lateral).
export function removeChipsForAmount(counts, amount, valuesMap) {
  const values = valuesMap || chipValues;
  const order = ['preta', 'azul', 'vermelha', 'verde', 'branca', 'amarela'];
  let remaining = amount;
  order.forEach(function (color) {
    while (remaining > 0 && counts[color] > 0 && values[color] <= remaining) {
      counts[color] -= 1;
      remaining -= values[color];
    }
  });
  // Caso não sobre uma combinação exata (raro), força a remoção do que tiver disponível.
  if (remaining > 0) {
    for (const color of ['branca', 'amarela', 'verde', 'vermelha', 'azul', 'preta']) {
      while (remaining > 0 && counts[color] > 0) {
        counts[color] -= 1;
        remaining -= values[color];
      }
      if (remaining <= 0) break;
    }
  }
}
