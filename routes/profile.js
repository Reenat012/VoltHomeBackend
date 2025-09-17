import express from "express";
import {authMiddleware} from "../utils/jwt.js";

const router = express.Router();

// GET /profile/me
router.get("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid || "yandex-uid-demo";
    // Здесь можно подтянуть профиль из БД; пока — детерминированный мок
    res.json({
        displayName: "Volt User",
        email: "user@example.com",
        avatarUrl: null,
        plan: "free",
        planUntilEpochSeconds: null,
        uid
    });
});

export default router;