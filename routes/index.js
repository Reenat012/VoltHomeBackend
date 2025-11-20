// routes/index.js

import express from "express";
import authRoutes from "./auth.js";
import profileRoutes from "./profile.js";
import projectsRoutes from "./projects.js";
import roomsRoutes from "./rooms.js";
import groupsRoutes from "./groups.js";
import devicesRoutes from "./devices.js";
import billingRoutes from "./billing.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/profile", profileRoutes);
router.use("/projects", projectsRoutes);
router.use("/rooms", roomsRoutes);
router.use("/groups", groupsRoutes);
router.use("/devices", devicesRoutes);
router.use("/billing", billingRoutes);

export default router;