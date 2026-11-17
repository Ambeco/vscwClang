#ifndef MK_PWD_H
#define MK_PWD_H
#include <sys/types.h>
struct passwd { char *pw_name; char *pw_dir; uid_t pw_uid; gid_t pw_gid; };
struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
#endif
