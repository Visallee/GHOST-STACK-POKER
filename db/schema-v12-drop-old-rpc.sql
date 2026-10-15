-- ===========================================================
-- GhostStackPoker — schema-v12-drop-old-rpc.sql
-- Limpeza da função antiga para evitar conflito de overload
-- ===========================================================

DROP FUNCTION IF EXISTS join_room_secure(text, text, integer, boolean, boolean);