import { runGuestWorker } from './guestWorker';

// Entry point bundled to dist/web/host/guestWorker.web.js and loaded into a Worker by the extension host.
runGuestWorker({
	postMessage: (message, transfer) => self.postMessage(message, transfer ?? []),
	onMessage: listener => { self.onmessage = ev => listener(ev.data); },
});
