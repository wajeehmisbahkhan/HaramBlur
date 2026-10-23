import {
    calcResize,
    loadVideo,
    getCanvas,
    emitEvent,
    requestIdleCB,
    canvToBlob,
} from "./helpers";
import { removeBlurryStart } from "./style";
import { STATUSES } from "../constants.js";

const FRAME_RATE = 1000 / 25; // 25 fps

// threshold for number of consecutive frames that need to be positive for the image to be considered positive
const POSITIVE_THRESHOLD = 1; //at 25 fps, this is 0.04 seconds of consecutive positive detections
// threshold for number of consecutive frames that need to be negative for the image to be considered negative
const NEGATIVE_THRESHOLD = 3; //at 25 fps, this is 0.12 seconds of consecutive negative detections
// clear results older than this (in video seconds) no longer describe what's on screen
const STALE_FRAME_SECONDS = 0.5;
const FRAME_RESPONSE_TIMEOUT = 5000;
const PAUSED_CHECK_RETRIES = 50;
const HAVE_CURRENT_DATA = 2;
// frames are shrunk to this size to cheaply compare them for scene changes
const SCENE_WIDTH = 32;
const SCENE_HEIGHT = 18;
// average per-pixel brightness change (0-255) that counts as a new scene
const SCENE_CHANGE_THRESHOLD = 20;
/**
 * Object containing the possible results of image processing.
 * @typedef {Object} RESULTS
 * @property {string} CLEAR - Indicates that the image is clear and safe to display.
 * @property {string} NSFW - Indicates that the image contains NSFW content and should be blurred.
 * @property {string} FACE - Indicates that the image contains a face and should be blurred.
 * @property {string} ERROR - Indicates that an error occurred during processing.
 */
const RESULTS = {
    CLEAR: "CLEAR",
    NSFW: "NSFW",
    FACE: "FACE",
    ERROR: "ERROR",
};

let activeFrame = false;
let canv, ctx, sceneCtx;

const processImage = (node, STATUSES) => {
    try {
        node.dataset.HBstatus = STATUSES.PROCESSING;
        chrome.runtime.sendMessage(
            {
                type: "imageDetection",
                image: {
                    src: node.src,
                    width: node.width || node.naturalWidth,
                    height: node.height || node.naturalHeight,
                },
            },
            (response) => {
                // console.log("HB== handleElementProcessing", response, node)
                removeBlurryStart(node);
                if (response.type === "error") {
                    console.warn("HB==Error while processing image", response);
                    node.dataset.HBstatus = STATUSES.ERROR;
                    return;
                }
                if (response === "face" || response === "nsfw") {
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                    node.classList.add("hb-blur");
                    node.dataset.HBresult = response;
                } else if (response == false) {
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                    node.classList.remove("hb-blur");
                    delete node.dataset.HBresult;
                } else {
                    console.warn(
                        "HB==Unknown response from processing image",
                        response
                    );
                    node.dataset.HBstatus = STATUSES.ERROR;
                }
            }
        );
    } catch (e) {
        console.log("HB==ERROR", e);
    }
};

const processFrame = async (video, { width, height }) => {
    // nothing drawable yet (e.g. mid-buffer): a blank frame would wrongly read as clear
    if (!video || video.ended || video.readyState < HAVE_CURRENT_DATA) {
        return { result: "skipped" };
    }
    return new Promise(async (resolve, reject) => {
        try {
            ctx.drawImage(video, 0, 0, width, height);

            const blob = await canvToBlob(canv, {
                type: "image/jpeg",
                quality: 0.6,
            });
            let data = URL.createObjectURL(blob);
            // never let a lost response stall detection for the whole tab
            const timeout = setTimeout(() => {
                URL.revokeObjectURL(data);
                resolve({ result: "skipped" });
            }, FRAME_RESPONSE_TIMEOUT);
            chrome.runtime.sendMessage(
                {
                    type: "videoDetection",
                    frame: {
                        data: data,
                        timestamp: video.currentTime,
                    },
                },
                (response) => {
                    clearTimeout(timeout);
                    // revoke the object url to free up memory
                    URL.revokeObjectURL(data);
                    resolve(response ?? { result: "skipped" });
                }
            );
        } catch (e) {
            reject(e);
        }
    });
};

const checkFrame = (video, dims) => {
    activeFrame = true;
    const capturedWhilePaused = video.paused;
    const capturedScene = video.HBscene;
    processFrame(video, dims)
        .then(({ result, timestamp }) => {
            if (result === "error") {
                throw new Error("HB==Error from processFrame");
            }

            // if frame was skipped, don't process it
            if (result === "skipped") {
                return;
            }

            // a positive is never too old to act on, but a clear result has to describe what's on screen now,
            // so it can't come from before the latest scene change
            const isPositive = result === "nsfw" || result === "face";
            if (
                !isPositive &&
                (video.HBscene !== capturedScene ||
                    Math.abs(video.currentTime - timestamp) >
                        STALE_FRAME_SECONDS)
            ) {
                return;
            }

            // a paused frame can't change, so one clear check of it is conclusive
            const isConclusive =
                capturedWhilePaused &&
                video.paused &&
                video.currentTime === timestamp;

            // process the result
            processVideoDetections(result, video, isConclusive);
        })
        .catch((error) => {
            console.log("HB==Video detection loop error", error, video);
            video.dataset.HBerrored =
                parseInt(video.dataset.HBerrored ?? 0) + 1;
        })
        .finally(() => {
            activeFrame = false;
        });
};

// the loop only samples playing video, so check the frame left on screen when it stops
const checkPausedFrame = (video, attempt = 0) => {
    if (
        !video.paused ||
        video.seeking ||
        !video.HBdims ||
        video.dataset.HBstatus === STATUSES.DISABLED
    ) {
        return;
    }
    if (activeFrame) {
        if (attempt < PAUSED_CHECK_RETRIES) {
            setTimeout(() => checkPausedFrame(video, attempt + 1), FRAME_RATE);
        }
        return;
    }
    checkFrame(video, video.HBdims);
};

// fail closed: cover the video whenever its picture may change before it's been checked
const blurUntilCleared = (video) => {
    if (video.dataset.HBstatus === STATUSES.DISABLED) return;
    video.HBscene = (video.HBscene ?? 0) + 1;
    video.HBnegativeCount = 0;
    video.classList.add("hb-blur");
};

// detection is far slower than playback, so blur on any cut to a new scene until the detector has seen it
const watchForSceneChange = (video) => {
    if (video.readyState < HAVE_CURRENT_DATA) return;
    try {
        if (!sceneCtx) {
            sceneCtx = getCanvas(SCENE_WIDTH, SCENE_HEIGHT, true).getContext(
                "2d",
                { willReadFrequently: true }
            );
        }
        sceneCtx.drawImage(video, 0, 0, SCENE_WIDTH, SCENE_HEIGHT);
        const { data } = sceneCtx.getImageData(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
        const prevSignature = video.HBsignature;
        const signature = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT);
        let totalDiff = 0;
        for (let i = 0; i < signature.length; i++) {
            const p = i * 4;
            signature[i] =
                (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
            if (prevSignature) {
                totalDiff += Math.abs(signature[i] - prevSignature[i]);
            }
        }
        video.HBsignature = signature;
        if (
            prevSignature &&
            totalDiff / signature.length > SCENE_CHANGE_THRESHOLD
        ) {
            blurUntilCleared(video);
        }
    } catch (e) {
        // unreadable (e.g. cross-origin) frames also fail detection, which is counted there
    }
};

const videoDetectionLoop = async (video, { width, height }) => {
    // get the current timestamp
    const currTime = performance.now();

    if (!video?.HBprevTime) {
        video.HBprevTime = currTime;
    }

    // calculate the time difference
    const diffTime = currTime - video.HBprevTime;

    if (video.dataset.HBstatus === STATUSES.DISABLED) {
        video.classList.remove("hb-blur");
    }
    const isActive =
        !video.ended &&
        !video.paused &&
        video.dataset.HBstatus !== STATUSES.DISABLED;
    // runs every animation frame, unlike detection, so a cut is covered almost as soon as it's painted
    if (isActive) {
        watchForSceneChange(video);
    }
    if (isActive && diffTime >= FRAME_RATE) {
        // store the current timestamp
        video.HBprevTime = currTime;

        if (!activeFrame) {
            checkFrame(video, { width, height });
        }
    }

    if (video.dataset.HBerrored > 10) {
        // remove onplay listener
        video.onplay = null;
        cancelAnimationFrame(video.HBrafId);
        video.removeAttribute("crossorigin");
        return;
    }
    if (!video.paused) {
        video.HBrafId = requestAnimationFrame(() =>
            videoDetectionLoop(video, { width, height })
        );
    } else {
        video.onplay = () => {
            video.HBrafId = requestAnimationFrame(() =>
                videoDetectionLoop(video, { width, height })
            );
        };
    }
};
const processVideo = async (node) => {
    try {
        // pre-blur: nothing is shown until a frame has been checked
        blurUntilCleared(node);
        if (!node.HBlistening) {
            node.HBlistening = true;
            ["seeking", "waiting", "emptied"].forEach((type) =>
                node.addEventListener(type, () => blurUntilCleared(node))
            );
            ["pause", "seeked", "loadeddata"].forEach((type) =>
                node.addEventListener(type, () => checkPausedFrame(node))
            );
        }
        // a src change re-processes the node, so stop the previous loop
        cancelAnimationFrame(node.HBrafId);

        node.dataset.HBstatus = STATUSES.LOADING;
        await loadVideo(node);
        node.dataset.HBstatus = STATUSES.PROCESSING;
        const { newWidth, newHeight } = calcResize(
            node.videoWidth ?? node.clientWidth,
            node.videoHeight ?? node.clientHeight,
            "video"
        );
        if (!canv) {
            canv = getCanvas(newWidth, newHeight, true);
            ctx = canv.getContext("2d", {
                alpha: false,
                willReadFrequently: true,
            });
        }
        // set the width and height of the video
        node.width = newWidth;
        node.height = newHeight;
        node.HBdims = { width: newWidth, height: newHeight };

        if (canv.width !== newWidth || canv.height !== newHeight) {
            canv.width = newWidth;
            canv.height = newHeight;
        }

        removeBlurryStart(node);

        // start the video detection loop but don't block the main thread
        requestIdleCB(() => {
            videoDetectionLoop(node, { width: newWidth, height: newHeight });
            checkPausedFrame(node);
        });
    } catch (e) {
        console.log("HB== processVideo error", e);
    }
};

const processVideoDetections = (result, video, isConclusive = false) => {
    const currentPositiveCount = parseInt(video.HBpositiveCount ?? 0);
    const currentNegativeCount = parseInt(video.HBnegativeCount ?? 0);
    let shouldBlur = null;

    if (result === "nsfw" || result === "face") {
        video.dataset.HBresult =
            result === "nsfw" ? RESULTS.NSFW : RESULTS.FACE;
        video.HBpositiveCount = currentPositiveCount + 1;
        video.HBnegativeCount = 0;
        // if the positive count is greater than the threshold (i.e it's not a momentary blip), add the blur
        if (video.HBpositiveCount >= POSITIVE_THRESHOLD) {
            shouldBlur = true;
            video.HBpositiveCount = 0;
        }
    } else {
        video.dataset.HBresult = RESULTS.CLEAR;
        video.HBnegativeCount = isConclusive
            ? NEGATIVE_THRESHOLD
            : currentNegativeCount + 1;
        video.HBpositiveCount = 0;
        // if the negative count is greater than the threshold (i.e it's not a momentary blip), remove the blur
        if (video.HBnegativeCount >= NEGATIVE_THRESHOLD) {
            shouldBlur = false;
            video.HBnegativeCount = 0;
        }
    }

    if (shouldBlur !== null) {
        shouldBlur
            ? video.classList.add("hb-blur")
            : video.classList.remove("hb-blur");
    }
};
export { processImage, processVideo };
