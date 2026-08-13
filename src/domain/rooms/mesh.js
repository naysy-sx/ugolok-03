// Rooms mesh — топология голосовой сетки, турнир по паре

/**
 * @param {string[]} pubkeys - Массив публичных ключей узлов.
 * @returns {Array<[string, string]>} Массив пар [initiator, responder], отсортированных лексикографически.
 */
function edges(pubkeys) {
    let sorted = pubkeys.sort();
    let result = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            result.push([sorted[i], sorted[j]]);
        }
    }
    return result;
}

/**
 * @param {Array<[string, string]>} oldEdges - Массив текущих пар рёбер.
 * @param {Array<[string, string]>} newEdges - Новый массив пар рёбер.
 * @returns {{toOpen: Array<[string, string]>, toClose: Array<[string, string]>}} Объект с массивами разниц.
 */
function diffEdges(oldEdges, newEdges) {
    let oldSet = new Set(oldEdges.map(e => e.join(':')));
    let newSet = new Set(newEdges.map(e => e.join(':')));
    let toOpen = [];
    let toClose = [];

    newEdges.forEach(edge => {
        if (!oldSet.has(edge.join(':'))) {
            toOpen.push(edge);
        }
    });

    oldEdges.forEach(edge => {
        if (!newSet.has(edge.join(':'))) {
            toClose.push(edge);
        }
    });

    return { toOpen, toClose };
}

export { edges, diffEdges };
