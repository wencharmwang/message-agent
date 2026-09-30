"""Keep Runtime receipts visible without ever retrying a send."""
def normalize_send_outcome(outcome):
    result = dict(outcome)
    receipt = result.get('receipt') or {}
    verification = receipt.get('verification', '') if isinstance(receipt, dict) else ''
    status = result.get('status') or 'uncertain'
    code = result.get('code') or ''
    if not code and verification.startswith('not_submitted:'):
        code = verification.split(':', 1)[1]
    if not code and status != 'sent':
        code = status
    result.update(status=status, code=code,
                  detail=result.get('detail') or verification or code)
    return result
