// wasi-threads fixture (target wasm32-wasip1-threads). No argument: 4 threads each add 1000 to a mutex-protected
// counter and one writes to stderr; prints the total. Argument "exit": a thread calls _exit(7), which must end the process.
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static long counter;

static void* add(void* arg) {
	for (int i = 0; i < 1000; i++) {
		pthread_mutex_lock(&lock);
		counter++;
		pthread_mutex_unlock(&lock);
	}
	if ((long)arg == 2) { fputs("hello from thread 2\n", stderr); }
	return 0;
}

static void* leave(void* arg) { (void)arg; _exit(7); return 0; }

int main(int argc, char** argv) {
	pthread_t threads[4];
	if (argc > 1 && strcmp(argv[1], "exit") == 0) {
		pthread_create(&threads[0], 0, leave, 0);
		pthread_join(threads[0], 0);
		return 0; // not reached
	}
	for (long i = 0; i < 4; i++) { pthread_create(&threads[i], 0, add, (void*)i); }
	for (int i = 0; i < 4; i++) { pthread_join(threads[i], 0); }
	printf("counter = %ld\n", counter);
	return counter == 4000 ? 0 : 1;
}
