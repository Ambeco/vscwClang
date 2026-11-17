CC = cc
CFLAGS = -O2 -Wall  -DNAME=1
all: libx.a test
libx.a: lib.o
	@echo archiving
	ar rcs $@ $^
	@ranlib $@
test: t.o libx.a
	$(CC) -o $@ t.o 	 -L. -lx
%.o: %.c lib.h
	$(CC) $(CFLAGS) -c $< -o $@
clean:
	-rm -f *.o *.a test
sub:
	$(MAKE) -C sub all
.PHONY: all clean sub
