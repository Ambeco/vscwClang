#include <errno.h>
#include <signal.h>
#include <sys/types.h>
#include <unistd.h>
int kill(pid_t p, int s) { (void)p; (void)s; errno = ENOSYS; return -1; }
int sigemptyset(sigset_t *s) { *s = (sigset_t){0}; return 0; }
int sigfillset(sigset_t *s) { (void)s; return 0; }
int sigaddset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
int sigdelset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
int sigismember(const sigset_t *s, int n) { (void)s; (void)n; return 0; }
int sigprocmask(int h, const sigset_t *a, sigset_t *b) { (void)h; (void)a; (void)b; return 0; }
pid_t waitpid(pid_t p, int *st, int o) { (void)p; (void)st; (void)o; errno = ENOSYS; return -1; }
pid_t wait(int *st) { (void)st; errno = ENOSYS; return -1; }
pid_t fork(void) { errno = ENOSYS; return -1; }
int pipe(int f[2]) { (void)f; errno = ENOSYS; return -1; }
#include <sys/stat.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
mode_t umask(mode_t m) { return m; }
pid_t vfork(void) { errno = ENOSYS; return -1; }
int execvp(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
struct passwd *getpwnam(const char *n) { (void)n; return 0; }
struct passwd *getpwuid(uid_t u) { (void)u; return 0; }
int mkstemp(char *t) { (void)t; errno = ENOSYS; return -1; }
#include <stdio.h>
char *getlogin(void) { return 0; }
FILE *tmpfile(void) { errno = ENOSYS; return 0; }
