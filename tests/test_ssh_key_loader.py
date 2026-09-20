import paramiko
import pytest


def test_loads_rsa_key(rsa_private_key_pem):
    from app.ssh_key_loader import load_private_key

    assert isinstance(load_private_key(rsa_private_key_pem), paramiko.RSAKey)


def test_loads_rsa_key_in_openssh_container(rsa_openssh_private_key_pem):
    from app.ssh_key_loader import load_private_key

    assert isinstance(
        load_private_key(rsa_openssh_private_key_pem),
        paramiko.RSAKey,
    )


def test_loads_ed25519_key(ed25519_private_key_pem):
    from app.ssh_key_loader import load_private_key

    assert isinstance(
        load_private_key(ed25519_private_key_pem),
        paramiko.Ed25519Key,
    )


def test_loads_ecdsa_key(ecdsa_private_key_pem):
    from app.ssh_key_loader import load_private_key

    assert isinstance(
        load_private_key(ecdsa_private_key_pem),
        paramiko.ECDSAKey,
    )


def test_loads_ecdsa_key_in_openssh_container(
        ecdsa_openssh_private_key_pem):
    from app.ssh_key_loader import load_private_key

    assert isinstance(
        load_private_key(ecdsa_openssh_private_key_pem),
        paramiko.ECDSAKey,
    )


@pytest.mark.parametrize(
    ('fixture_name', 'expected'),
    [
        ('rsa_private_key_pem', 'RSA'),
        ('ed25519_private_key_pem', 'Ed25519'),
        ('ecdsa_private_key_pem', 'ECDSA'),
    ],
)
def test_identifies_supported_key_types(request, fixture_name, expected):
    from app.ssh_key_loader import identify_private_key

    key_content = request.getfixturevalue(fixture_name)
    assert identify_private_key(key_content) == expected


def test_rejects_dsa_with_actionable_error(dsa_private_key_pem):
    from app.ssh_key_loader import (
        UnsupportedPrivateKeyError,
        load_private_key,
    )

    with pytest.raises(UnsupportedPrivateKeyError, match='DSA'):
        load_private_key(dsa_private_key_pem)


def test_rejects_invalid_key_without_echoing_material():
    from app.ssh_key_loader import (
        UnsupportedPrivateKeyError,
        load_private_key,
    )

    secret = 'not-a-private-key-secret'
    with pytest.raises(UnsupportedPrivateKeyError) as exc_info:
        load_private_key(secret)

    assert secret not in str(exc_info.value)


@pytest.mark.parametrize(
    'value',
    ['', '   ', None, b'private-key-bytes'],
)
def test_rejects_empty_or_non_string_key_material_without_leaking_input(value):
    from app.ssh_key_loader import (
        UnsupportedPrivateKeyError,
        load_private_key,
    )

    with pytest.raises(UnsupportedPrivateKeyError) as exc_info:
        load_private_key(value)

    assert str(exc_info.value) == 'Unsupported or invalid private key format'


def test_encrypted_key_requires_passphrase_without_leaking_it(
        encrypted_rsa_private_key_pem):
    from app.ssh_key_loader import load_private_key

    with pytest.raises(paramiko.PasswordRequiredException) as exc_info:
        load_private_key(encrypted_rsa_private_key_pem)

    assert 'test-passphrase' not in str(exc_info.value)
