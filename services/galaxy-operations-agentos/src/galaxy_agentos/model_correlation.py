"""Bind a native run to one request without mutating a shared model."""
from functools import wraps

from .model_usage import _RUN
from .tool_call_ids import valid_run_context_id


def install_model_correlation(model):
    original = model.get_request_params

    @wraps(original)
    def parameters(*args, **kwargs):
        result = dict(original(*args, **kwargs))
        headers = dict(result.get('extra_headers') or {})
        # Never accept a preconfigured value as the current run identity.
        for key in list(headers):
            if key.lower() == 'x-galaxy-native-run-id':
                headers.pop(key)
        run_id = getattr(_RUN.get(), 'run_id', None)
        if valid_run_context_id(run_id):
            headers['X-Galaxy-Native-Run-Id'] = run_id
        if headers:
            result['extra_headers'] = headers
        else:
            result.pop('extra_headers', None)
        return result

    model.get_request_params = parameters
    return model
