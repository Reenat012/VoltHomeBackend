export default {
    testEnvironment: "node",
    testTimeout: 30000,
    // Логи приложения в тестах скрыты; чтобы увидеть: TEST_LOGS=1 npm test
    silent: !process.env.TEST_LOGS,
    globalSetup: "./tests/setup/globalSetup.js",
    setupFiles: ["./tests/setup/env.js"],
    testPathIgnorePatterns: ["/node_modules/", "/.testdb/"],
};
