// Configuração explícita: impede que o .env local altere os testes offline.
const ambiente = {
  "APP_URL": "",
  "DATABASE_PATH": "",
  "DATABASE_SSL": "0",
  "DATABASE_URL": "postgresql://postgres:teste@localhost:5432/goatskins_test",
  "DATA_DIR": "",
  "EMAIL_API_KEY": "",
  "EMAIL_DRIVER": "console",
  "EMAIL_FROM": "",
  "MP_ACCESS_TOKEN": "",
  "MP_API_BASE": "https://api.mercadopago.com",
  "MP_TESTE_APRO": "0",
  "MP_WEBHOOK_SECRET": "",
  "NODE_ENV": "test",
  "PG_POOL_MAX": "",
  "PIX_MINUTOS": "",
  "PORT": "",
  "RESERVA_SEGUNDOS": "",
  "SQLITE_PATH": "",
  "TESTE": "",
  "TRUST_PROXY": "1",
  "TRUST_PROXY_HOPS": "2"
};
Object.assign(process.env, ambiente);
module.exports = ambiente;
