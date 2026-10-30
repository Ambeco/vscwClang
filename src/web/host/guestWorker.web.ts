import { runGuestWorker } from './guestWorker';

// Entry point bundled to dist/web/host/guestWorker.web.js and loaded into a Worker by the extension host.
// A thread spawner starts its threads from this same script (its own blob URL).
runGuestWorker({
	postMessage: (message, transfer) => self.postMessage(message, transfer ?? []),
	onMessage: listener => { self.onmessage = ev => listener(ev.data); },
}, () => {
	const worker = new Worker(self.location.href);
	return { postMessage: message => worker.postMessage(message), onMessage: listener => { worker.onmessage = ev => listener(ev.data); } };
});
