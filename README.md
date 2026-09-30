# NexGent Gestión

Facturación, gastos y resumen trimestral de NEXGENT AI SYSTEMS S.L.

- Front: `index.html` (sin build).
- Datos, PDFs y login: Supabase (proyecto `nexgent-gestion`, ref `lualgzhmwclrnuqgmxlb`).
- Importar gastos del correo: funciones en `api/mail/*` (IMAP del webmail + API de Claude).

## Variables de entorno en Vercel

| Variable | Valor |
|---|---|
| SUPABASE_URL | https://lualgzhmwclrnuqgmxlb.supabase.co |
| SUPABASE_ANON_KEY | sb_publishable_BBw3Zv_CRtM1vfeufZgPrQ_Pefo9tho |
| IMAP_HOST | servidor IMAP del webmail (p. ej. imap.hostinger.com) |
| IMAP_PORT | 993 |
| IMAP_USER | info@nexgent.io |
| IMAP_PASSWORD | contraseña del buzón (marcar como Sensitive) |
| IMAP_FOLDERS | INBOX (separa varias con comas) |
| ANTHROPIC_API_KEY | clave de console.anthropic.com (Sensitive) |

## Supabase: una sola vez
Authentication → URL Configuration → Site URL = la URL de Vercel (p. ej. https://nexgent-gestion.vercel.app) y añádela también en Redirect URLs.

Emails con acceso: tabla `allowed_users`.
