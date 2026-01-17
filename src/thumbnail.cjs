const noblox = require('noblox.js');

const VALID_SIZES = ['30x30', '48x48', '60x60', '75x75', '100x100', '150x150', '180x180', '420x420'];
const VALID_FORMATS = ['png', 'jpeg'];
const VALID_CROP_TYPES = ['headshot', 'body'];

process.on('message', async (msg) => {
    const { identifier, size, format, isCircular, cropType, requestId } = msg;

    if (!requestId) return;

    let userId;
    if (typeof identifier === 'string') {
        try {
            userId = await noblox.getIdFromUsername(identifier);
        } catch {
            return process.send({ requestId, success: false, message: 'User not found' });
        }
    } else if (typeof identifier === 'number') {
        userId = identifier;
    } else {
        return process.send({ requestId, success: false, message: 'Invalid identifier' });
    }

    const finalSize = VALID_SIZES.includes(size) ? size : '48x48';
    const finalFormat = VALID_FORMATS.includes(format) ? format : 'png';
    const finalIsCircular = Boolean(isCircular);
    const finalCropType = VALID_CROP_TYPES.includes(cropType) ? cropType : 'headshot';

    try {
        const result = await noblox.getPlayerThumbnail(
            userId,
            finalSize,
            finalFormat,
            finalIsCircular,
            finalCropType
        );
        if (result[0]?.imageUrl) {
            process.send({ requestId, success: true, thumbnail: result[0].imageUrl });
        } else {
            process.send({ requestId, success: false, message: 'Thumbnail generation failed' });
        }
    } catch (err) {
        process.send({ requestId, success: false, message: 'Thumbnail service error' });
    }
});

console.log('[thumbnail] Worker ready (customizable via noblox.js)');