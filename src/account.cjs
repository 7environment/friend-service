// src/account.cjs
const noblox = require('noblox.js');
const fs = require('fs');
const path = require('path');

const cookie = process.env.ROBLOX_COOKIE;
const alias = process.env.ACCOUNT_ALIAS;

if (!cookie || !alias) {
    console.error(`[FATAL][${alias}] Missing ROBLOX_COOKIE or ACCOUNT_ALIAS`);
    process.exit(1);
}

// Путь к файлу очереди
const PENDING_FILE = path.resolve(__dirname, '..', `pending_${alias}.json`);

let currentUserId;
const pendingRequests = new Map(); // username → { userId, checkInterval }

// === Функции для работы с файлом ===
function loadPendingQueue() {
    try {
        if (fs.existsSync(PENDING_FILE)) {
            const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
            for (const [username, userId] of Object.entries(data)) {
                pendingRequests.set(username, { userId: Number(userId) });
                console.log(`[PERSIST][${alias}] 📥 Restored pending: ${username} (ID: ${userId})`);
            }
        } else {
            console.log(`[PERSIST][${alias}] No pending file found — starting fresh`);
        }
    } catch (err) {
        console.error(`[ERROR][${alias}] Failed to load pending queue:`, err.message);
    }
}

function savePendingQueue() {
    try {
        const data = {};
        for (const [username, entry] of pendingRequests.entries()) {
            data[username] = entry.userId;
        }
        fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[PERSIST][${alias}] 💾 Saved ${pendingRequests.size} pending requests to ${PENDING_FILE}`);
    } catch (err) {
        console.error(`[ERROR][${alias}] Failed to save pending queue:`, err.message);
    }
}

// === Инициализация ===
(async () => {
    try {
        await noblox.setCookie(cookie);
        const user = await noblox.getAuthenticatedUser();
        currentUserId = user.id;
        console.log(`[INFO][${alias}] ✅ Authenticated as ${user.name} (ID: ${currentUserId})`);

        // Загружаем очередь
        loadPendingQueue();

        // Запускаем фоновую проверку для восстановленных
        for (const [username, entry] of pendingRequests.entries()) {
            startPendingCheck(username, entry.userId);
        }
    } catch (err) {
        console.error(`[FATAL][${alias}] Authentication failed:`, err.message);
        process.exit(1);
    }
})();

// === Вспомогательные функции ===
async function getIdFromUsernameSafe(username) {
    try {
        return await noblox.getIdFromUsername(username);
    } catch {
        return null;
    }
}

async function hasIncomingRequest(userId) {
    try {
        const data = await noblox.getFriendRequests("Asc", 100);
        return data.data.some(req => req.id === userId);
    } catch (err) {
        console.warn(`[WARN][${alias}] Failed to fetch friend requests:`, err.message);
        return false;
    }
}

async function isFriend(userId) {
    try {
        const friends = await noblox.getFriends(currentUserId);
        return friends.data.some(f => f.id === userId);
    } catch (err) {
        console.warn(`[WARN][${alias}] Failed to fetch friends list:`, err.message);
        return false;
    }
}

async function attemptAccept(username, userId) {
    if (await isFriend(userId)) {
        return { success: true, message: `${username} is already a friend`, userId };
    }

    if (await hasIncomingRequest(userId)) {
        try {
            await noblox.acceptFriendRequest(userId);
            return { success: true, message: `Accepted friend request from ${username}`, userId };
        } catch (err) {
            console.error(`[ERROR][${alias}] Accept failed for ${username}:`, err.message);
            return { success: false, message: `Accept failed: ${err.message}` };
        }
    }

    return { success: false, message: 'No request yet' };
}

function startPendingCheck(username, userId) {
    if (pendingRequests.has(username)) {
        const checkInterval = setInterval(async () => {
            const retry = await attemptAccept(username, userId);
            if (retry.success) {
                console.log(`[ACTION][${alias}] ✅ Auto-accepted pending request from "${username}" (ID: ${userId})`);
                clearInterval(checkInterval);
                pendingRequests.delete(username);
                savePendingQueue(); // обновляем файл
            }
        }, 5000);
        pendingRequests.get(username).checkInterval = checkInterval;
    }
}

// === Обработка команд ===
process.on('message', async (msg) => {
    const { type, username, requestId } = msg;

    if (!requestId) {
        console.warn(`[WARN][${alias}] Message without requestId — ignored`);
        return;
    }

    if (!username || typeof username !== 'string') {
        console.warn(`[WARN][${alias}] Invalid username:`, username);
        process.send({ requestId, success: false, status: 400, message: 'Invalid username' });
        return;
    }

    console.log(`[INFO][${alias}] 📥 Command: ${type} for "${username}" (requestId: ${requestId})`);

    const userId = await getIdFromUsernameSafe(username);
    if (!userId) {
        const errorMsg = `Username "${username}" not found on Roblox`;
        console.error(`[ERROR][${alias}] ❌ ${errorMsg}`);
        process.send({ requestId, success: false, status: 404, message: errorMsg });
        return;
    }

    try {
        if (type === 'accept') {
            const result = await attemptAccept(username, userId);

            if (result.success) {
                console.log(`[ACTION][${alias}] ✅ ${result.message}`);
                process.send({ requestId, success: true, userId, message: result.message });
            } else {
                if (!pendingRequests.has(username)) {
                    pendingRequests.set(username, { userId });
                    startPendingCheck(username, userId);
                    savePendingQueue(); // сохраняем сразу
                    console.log(`[PENDING][${alias}] ⏳ Added "${username}" to persistent queue`);
                } else {
                    console.log(`[INFO][${alias}] ℹ️ "${username}" already in pending queue`);
                }

                process.send({
                    requestId,
                    success: true,
                    userId,
                    message: `No current request from "${username}". Added to persistent pending queue — will auto-accept when it arrives.`,
                    pending: true
                });
            }
        } else if (type === 'delete') {
            if (pendingRequests.has(username)) {
                const entry = pendingRequests.get(username);
                if (entry.checkInterval) clearInterval(entry.checkInterval);
                pendingRequests.delete(username);
                savePendingQueue();
                console.log(`[ACTION][${alias}] 🧹 Removed "${username}" from pending queue`);
            }

            let removed = false;
            try {
                await noblox.removeFriend(userId);
                removed = true;
                console.log(`[ACTION][${alias}] 🗑️ Removed friend "${username}"`);
            } catch {
                try {
                    await noblox.declineFriendRequest(userId);
                    removed = true;
                    console.log(`[ACTION][${alias}] 🚫 Declined request from "${username}"`);
                } catch {
                    console.log(`[INFO][${alias}] ℹ️ No relation to delete for "${username}"`);
                }
            }

            process.send({
                requestId,
                success: true,
                userId,
                message: removed ? `Removed/declined ${username}` : `${username} had no relation`
            });
        } else {
            console.warn(`[WARN][${alias}] Unknown action: ${type}`);
            process.send({ requestId, success: false, status: 400, message: 'Unknown action' });
        }
    } catch (err) {
        console.error(`[ERROR][${alias}] Unhandled error:`, err.message);
        process.send({ requestId, success: false, status: 500, message: `Operation failed: ${err.message}` });
    }
});