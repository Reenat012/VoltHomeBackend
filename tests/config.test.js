// tests/config.test.js
// Секреты обязательны: без них сервер не должен стартовать (раньше подставлялись запасные значения).
import { getJwtSecrets, getAccessTtlMinutes, getRefreshTtlDays } from "../utils/config.js";

const good = {
    JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32),
};

describe("Секреты подписи токенов", () => {
    test("нормальные секреты принимаются", () => {
        expect(getJwtSecrets(good)).toEqual({ access: "a".repeat(32), refresh: "b".repeat(32) });
    });

    test("нет access-секрета: ошибка с названием переменной", () => {
        expect(() => getJwtSecrets({ JWT_REFRESH_SECRET: good.JWT_REFRESH_SECRET })).toThrow(/JWT_ACCESS_SECRET/);
    });

    test("нет refresh-секрета: ошибка", () => {
        expect(() => getJwtSecrets({ JWT_ACCESS_SECRET: good.JWT_ACCESS_SECRET })).toThrow(/JWT_REFRESH_SECRET/);
    });

    test("старое имя SESSION_JWT_SECRET для access поддерживается", () => {
        const r = getJwtSecrets({ SESSION_JWT_SECRET: "c".repeat(20), JWT_REFRESH_SECRET: good.JWT_REFRESH_SECRET });
        expect(r.access).toBe("c".repeat(20));
    });

    test.each(["change-me", "access_dev_secret", "refresh_dev_secret", "very_secret_string"])(
        "прежний запасной секрет %s запрещён",
        (bad) => {
            expect(() => getJwtSecrets({ ...good, JWT_ACCESS_SECRET: bad })).toThrow(/по умолчанию/);
            expect(() => getJwtSecrets({ ...good, JWT_REFRESH_SECRET: bad })).toThrow(/по умолчанию/);
        }
    );

    test.each(["change-me-access-secret-long", "__PUT_LATER__PUT_LATER__"])(
        "заготовка из env.example %s запрещена",
        (bad) => {
            expect(() => getJwtSecrets({ ...good, JWT_ACCESS_SECRET: bad })).toThrow(/по умолчанию/);
        }
    );

    test("слишком короткий секрет запрещён", () => {
        expect(() => getJwtSecrets({ ...good, JWT_ACCESS_SECRET: "short" })).toThrow(/короче/);
    });

    test("access и refresh должны различаться", () => {
        expect(() => getJwtSecrets({ JWT_ACCESS_SECRET: "x".repeat(20), JWT_REFRESH_SECRET: "x".repeat(20) })).toThrow(
            /отличаться/
        );
    });
});

describe("Сроки", () => {
    test("по умолчанию access 30 минут, refresh 90 дней", () => {
        expect(getAccessTtlMinutes({})).toBe(30);
        expect(getRefreshTtlDays({})).toBe(90);
    });
    test("значения из окружения", () => {
        expect(getAccessTtlMinutes({ ACCESS_TTL_MIN: "15" })).toBe(15);
        expect(getRefreshTtlDays({ REFRESH_TTL_DAYS: "30" })).toBe(30);
    });
    test("мусор заменяется значением по умолчанию", () => {
        expect(getAccessTtlMinutes({ ACCESS_TTL_MIN: "abc" })).toBe(30);
        expect(getRefreshTtlDays({ REFRESH_TTL_DAYS: "-5" })).toBe(90);
    });
});
