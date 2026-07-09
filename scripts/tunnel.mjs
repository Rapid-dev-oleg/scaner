/**
 * Публичный доступ к Sentinel через ngrok — БИБЛИОТЕКА (@ngrok/ngrok), не CLI.
 * ngrok ходит по 443, поэтому работает там, где Cloudflare Tunnel (порт 7844)
 * блокируется фаерволом.
 *
 * Запуск:  npm run tunnel        (держите окно открытым — туннель живёт, пока жив процесс)
 *
 * Параметры через env (.env):
 *   NGROK_AUTHTOKEN  — токен агента ngrok (обязателен).
 *   NGROK_DOMAIN     — статический домен ngrok (необязательно; без него URL случайный).
 *   PORT             — порт приложения (по умолчанию 3001, как в docker-compose).
 */
import ngrok from '@ngrok/ngrok';

const authtoken = process.env.NGROK_AUTHTOKEN;
const domain = process.env.NGROK_DOMAIN || undefined;
const addr = Number(process.env.PORT || 3001);

if (!authtoken) {
  console.error('\n❌ Не задан NGROK_AUTHTOKEN (положите его в .env).');
  process.exit(1);
}

try {
  const listener = await ngrok.forward({ addr, authtoken, ...(domain ? { domain } : {}) });
  console.log('\n✅ Туннель поднят:');
  console.log('   ' + listener.url());
  console.log(`   → проксирует на http://localhost:${addr}`);
  console.log('\nСовет: пропишите этот URL в PUBLIC_BASE_URL (docker-compose/.env),');
  console.log('чтобы ссылки на отчёты в уведомлениях были кликабельными.');
  console.log('\nДержите это окно открытым. Ctrl+C — остановить.\n');
} catch (e) {
  console.error('\n❌ Не удалось поднять туннель:');
  console.error('   ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}

const keep = setInterval(() => {}, 1 << 30);
const stop = async () => {
  clearInterval(keep);
  try { await ngrok.disconnect(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
