"""Linux trial containment, inherited by every child; fail closed if unavailable.

Landlock limits file access without a mount/user namespace. Seccomp blocks outbound
connections and cross-process interference; listening HTTP sockets still work.
This is deliberately a read/import trial, not a provider execution environment.
"""
import ctypes
import errno
import os
from pathlib import Path
import platform
import sys


def confine(home, runtime):
    if sys.platform != 'linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise RuntimeError('Trial containment requires Linux x64/arm64')
    libc = ctypes.CDLL(None, use_errno=True)
    # Linux generic syscall numbers on x64 and arm64.
    if libc.syscall(444, 0, 0, 1) < 3:
        raise RuntimeError('Trial requires Landlock ABI >= 3')
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'no_new_privs')
    rights = (1 << 15) - 1  # EXECUTE through TRUNCATE (ABI 3)
    read = (1 << 0) | (1 << 2) | (1 << 3)

    class Ruleset(ctypes.Structure):
        _fields_ = [('handled_access_fs', ctypes.c_uint64)]

    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]

    ruleset = Ruleset(rights)
    fd = libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'landlock_create_ruleset')
    try:
        for path, allowed in [(home, rights), (runtime, read),
                              ('/usr', read), ('/lib', read), ('/lib64', read), ('/bin', read),
                              ('/etc/ld.so.cache', 4), ('/etc/localtime', 4),
                              ('/etc/ssl/openssl.cnf', 4), ('/etc/ssl/certs', read),
                              ('/dev/null', 6), ('/dev/urandom', 4), ('/dev/random', 4)]:
            path = Path(path).resolve()
            if not path.exists():
                continue
            parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule(allowed if path.is_dir() else allowed & ~8, parent)
                if libc.syscall(445, fd, 1, ctypes.byref(rule), 0) != 0:
                    raise OSError(ctypes.get_errno(), 'landlock_add_rule: ' + str(path))
            finally:
                os.close(parent)
        if libc.syscall(446, fd, 0) != 0:
            raise OSError(ctypes.get_errno(), 'landlock_restrict_self')
    finally:
        os.close(fd)
    sec = ctypes.CDLL('libseccomp.so.2')
    sec.seccomp_init.argtypes = [ctypes.c_uint32]
    sec.seccomp_init.restype = ctypes.c_void_p
    sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    sec.seccomp_load.argtypes = [ctypes.c_void_p]
    sec.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = sec.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError('seccomp_init failed')
    try:
        for name in ('connect', 'sendto', 'sendmsg', 'sendmmsg', 'kill', 'pidfd_send_signal',
                     'tkill', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'io_uring_setup'):
            nr = sec.seccomp_syscall_resolve_name(name.encode())
            if nr < 0 or sec.seccomp_rule_add(ctx, 0x50000 | errno.EPERM, nr, 0) != 0:
                raise RuntimeError('Cannot block syscall ' + name)
        # Node uses tgkill for its own threads; forbid other thread groups.
        class Compare(ctypes.Structure):
            _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int),
                        ('datum_a', ctypes.c_uint64), ('datum_b', ctypes.c_uint64)]
        sec.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Compare)]
        other_process = Compare(0, 1, os.getpid(), 0)  # SCMP_CMP_NE
        nr = sec.seccomp_syscall_resolve_name(b'tgkill')
        if sec.seccomp_rule_add_array(ctx, 0x50000 | errno.EPERM, nr, 1, ctypes.byref(other_process)) != 0:
            raise RuntimeError('Cannot constrain tgkill')
        if sec.seccomp_load(ctx) != 0:
            raise RuntimeError('Cannot load trial seccomp policy')
    finally:
        sec.seccomp_release(ctx)


if __name__ == '__main__':
    home, runtime, *command = sys.argv[1:]
    confine(home, runtime)
    os.execve(command[0], command, dict(os.environ))
