-- ===========================================================
-- GhostStackPoker — schema-v6-realtime-fix.sql
-- Corrige o Bug 4 (expulsão não é instantânea).
--
-- CAUSA: por padrão, o Postgres usa REPLICA IDENTITY "default", que só
-- inclui a CHAVE PRIMÁRIA no evento de DELETE enviado pelo Realtime.
-- Como o filtro que os clientes usam pra saber "essa mudança é da minha
-- sala" é `room_code=eq.XXXXX` (não é a chave primária), o evento de
-- exclusão não tinha como "bater" no filtro — e a expulsão só aparecia
-- pros outros jogadores quando ALGUMA OUTRA mudança (como o turno
-- passando) forçava um recarregamento geral por tabela inteira.
--
-- CORREÇÃO: manda o Postgres incluir a linha INTEIRA (não só o id) nos
-- eventos de UPDATE e DELETE dessas duas tabelas. Isso NÃO muda nenhuma
-- coluna nem apaga nada — é só uma configuração de replicação.
-- Rode isso no SQL Editor do Supabase.
-- ===========================================================

alter table players replica identity full;
alter table rooms replica identity full;
