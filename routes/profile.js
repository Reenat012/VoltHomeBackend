import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import { users } from "../stores/users.js";

const router = express.Router();

// GET /v1/profile/me (защищённый)
router.get("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid || "yandex-uid-demo";
    const row = users.get(uid);
    if (row) {
        const { displayName, email, avatarUrl, plan, planUntilEpochSeconds } = row;
        return res.json({ displayName, email, avatarUrl, plan, planUntilEpochSeconds, uid });
    }
    // Фолбек, если профиль ещё не сохраняли
    res.json({
        displayName: "Volt User",
        email: null,
        avatarUrl: null,
        plan: "free",
        planUntilEpochSeconds: null,
        uid
    });
});

export default router;