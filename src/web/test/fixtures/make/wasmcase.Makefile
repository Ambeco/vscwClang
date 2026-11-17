CC ?= cc
CFLAGS = -O2 -Wall
OBJS = lib.o
HOST := $(shell uname)
all: libx.a test
libx.a: $(OBJS)
	ar rcs $@ $^
	ranlib $@
test: t.o libx.a
	$(CC) -o $@ t.o -L. -lx
%.o: %.c lib.h
	$(CC) $(CFLAGS) -c $< -o $@
gen.mk:
	echo 'GEN=1' > gen.mk
-include gen.mk
sub:
	$(MAKE) -C . all
clean:
	rm -f *.o *.a test
.PHONY: all clean sub
