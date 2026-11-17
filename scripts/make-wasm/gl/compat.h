#ifndef MK_COMPAT_H
#define MK_COMPAT_H
#include <signal.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <stdlib.h>
#ifndef SIGHUP
#define SIGHUP 1
#endif
#ifndef SIGQUIT
#define SIGQUIT 3
#endif
#ifndef SIGKILL
#define SIGKILL 9
#endif
#ifndef SIGPIPE
#define SIGPIPE 13
#endif
#ifndef SIGCHLD
#define SIGCHLD 17
#endif
#ifndef SIGUSR1
#define SIGUSR1 10
#endif
#ifndef SIGALRM
#define SIGALRM 14
#endif
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
int kill(pid_t, int);
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
pid_t fork(void);
int pipe(int[2]);
mode_t umask(mode_t);
int mkstemp(char *);
pid_t vfork(void);
int execvp(const char *, char *const[]);
#endif
