"""The project's identity, in one place.

Everything that states what this build IS -- its name, version, licence and
the notice the licence requires be carried forward -- reads from here, so the
sign-in footer, `/api/version`, the response header and the tests cannot drift
apart from one another or from LICENSE.
"""

PROJECT_NAME = 'SSHDeck'
VERSION = '0.1.0'
SOURCE_URL = 'https://github.com/nguyenha935/SSHDeck'

LICENSE_ID = 'LicenseRef-PolyForm-Noncommercial-1.0.0'
LICENSE_NAME = 'PolyForm Noncommercial License 1.0.0'
LICENSE_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'

# Verbatim the line LICENSE carries. The licence obliges anyone who passes this
# software on to pass this line on with it, so it is published unchanged; a
# test asserts it still matches the first line of LICENSE.
REQUIRED_NOTICE = (
    'Required Notice: Copyright 2026 Nguyen Thanh Ha '
    '(https://github.com/nguyenha935/SSHDeck)'
)

COMMERCIAL_CONTACT = 'nguyenthanhha935@gmail.com'


def notice_payload():
    """What `/api/version` answers. No deployment detail, no account data."""
    return {
        'name': PROJECT_NAME,
        'version': VERSION,
        'license': LICENSE_ID,
        'license_name': LICENSE_NAME,
        'license_url': LICENSE_URL,
        'required_notice': REQUIRED_NOTICE,
        'source': SOURCE_URL,
        'commercial_licence_contact': COMMERCIAL_CONTACT,
    }
