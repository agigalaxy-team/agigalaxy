// Local Hub fixture compatibility only. The already-running synthetic Vite
// plugin used /app/src/runtime.mjs in an inline module, while Vite resolves
// source paths before adding its /app/ base. This shim is not imported by
// product code and is not included in the ordinary release build.
// Remove when the 56211/56214/56219 fixture origins no longer need preservation;
// new fixtures load the original module dynamically and do not use this file.
export {createWebRuntime,loadWebConfiguration} from '../../src/runtime.mjs';
