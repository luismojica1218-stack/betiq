-- ============================================================
-- Ejecuta este SQL en Supabase SQL Editor para confirmar 
-- el email del usuario demo y poder acceder al dashboard
-- ============================================================

-- Confirmar todos los usuarios pendientes
UPDATE auth.users 
SET email_confirmed_at = now()
WHERE email_confirmed_at IS NULL;

-- Verificar
SELECT id, email, email_confirmed_at 
FROM auth.users 
ORDER BY created_at DESC;
