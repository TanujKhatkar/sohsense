// Offline build stub — no service worker in the single-file version.
export const registerSW = () => () => Promise.resolve()
export default { registerSW }
