// Маппинг mime → глиф Phosphor для строки/плитки экрана «Файлы».
export function iconForFile(mime) {
    if (mime == null || typeof mime !== 'string') {
        return 'file-text';
    }

    switch (mime.split('/')[0]) {
        case 'audio':
            return 'file-audio';
        case 'video':
            return 'file-video';
        case 'image':
            return 'file-image';
        case 'application':
            switch (mime) {
                case 'application/pdf':
                    return 'file-pdf';
                case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
                case 'application/vnd.ms-excel':
                    return 'file-xls';
                case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                case 'application/msword':
                    return 'file-doc';
                default:
                    return 'file-text';
            }
        default:
            return 'file-text';
    }
}
