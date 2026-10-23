/* Evita que .env ou credenciais herdadas interfiram nos testes offline. */
const env = { NODE_ENV: 'test', RENDER: '', TESTE: '', MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', MP_TESTE_APRO: '',
 EMAIL_DRIVER: 'console', EMAIL_API_KEY: '', EMAIL_FROM: 'GOATSKINS <no-reply@goatskins.test>', EMAIL_CODE_SECRET: 'a'.repeat(64),
 DATABASE_URL: 'postgresql://postgres:postgres@localhost/goatskins_test', DATABASE_SSL: '0', APP_URL: 'http://localhost:3000',
 ORIGIN_VERIFY_SECRET:'', TURNSTILE_SITE_KEY:'', TURNSTILE_SECRET_KEY:'', TURNSTILE_HOSTNAMES:'', };
Object.assign(process.env, env);
module.exports = env;
