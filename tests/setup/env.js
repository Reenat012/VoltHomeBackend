// Выполняется в каждом тестовом процессе до загрузки приложения.
// Значения только для тестов; боевой .env не читается (см. DOTENV_CONFIG_PATH в npm test).
process.env.NODE_ENV = "test";
process.env.DISABLE_HTTPS_REDIRECT ??= "true";
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-not-for-production";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-not-for-production";
