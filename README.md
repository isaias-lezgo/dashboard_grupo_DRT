# dashboard_grupo_DRT

Panel de dashboards sobre datos de CRM (GoHighLevel) para **Grupo DRT**.

Fork monocliente del panel compartido `dashboards-GHL`, del que hereda todo el
código: sync a GHL con caché en Neon, filtros globales, drill-downs, exportación
a PDF y el asistente de IA.

La documentación real del repo vive en **[`CLAUDE.md`](./CLAUDE.md)** — arquitectura,
comandos, variables de entorno y las reglas de dominio. `DESIGN.md` tiene el sistema
de diseño y `PRODUCT.md` las audiencias.

## Arranque

```bash
pnpm install          # pnpm, NUNCA npm — ver CLAUDE.md
vercel env pull .env.local
pnpm dev              # localhost:3000
npx tsc --noEmit      # la verificación real; `next build` ignora errores de TS
```
