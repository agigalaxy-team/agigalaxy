import asyncio
import unittest
from types import SimpleNamespace

from agno.models.openai.like import OpenAILike
from agno.models.openai.responses import OpenAIResponses
from agno.models.message import Message
from galaxy_agentos.model_correlation import install_model_correlation
from galaxy_agentos.model_usage import _RUN


class ModelCorrelation(unittest.TestCase):
    def test_native_request_parameters_are_per_run_and_do_not_mutate_model(self):
        async def exercise(model):
            install_model_correlation(model)
            async def one(run_id):
                token = _RUN.set(SimpleNamespace(run_id=run_id))
                try:
                    await asyncio.sleep(0)
                    return model.get_request_params().get('extra_headers', {})
                finally:
                    _RUN.reset(token)
            a, b = await asyncio.gather(one('native-run-a'), one('native-run-b'))
            self.assertEqual(a['X-Galaxy-Native-Run-Id'], 'native-run-a')
            self.assertEqual(b['X-Galaxy-Native-Run-Id'], 'native-run-b')
            self.assertEqual(model.extra_headers, {'X-Existing': 'kept'})
            self.assertNotIn('X-Galaxy-Native-Run-Id', model.get_request_params().get('extra_headers', {}))
        for cls in (OpenAILike, OpenAIResponses):
            with self.subTest(adapter=cls.__name__):
                asyncio.run(exercise(cls(id='test', api_key='test', extra_headers={'X-Existing': 'kept'})))

    def test_all_native_invoke_paths_carry_current_run(self):
        for cls in (OpenAILike, OpenAIResponses):
            for mode in ('invoke', 'ainvoke', 'invoke_stream', 'ainvoke_stream'):
                with self.subTest(adapter=cls.__name__, mode=mode):
                    model = install_model_correlation(cls(id='test', api_key='test'))
                    observed = []
                    def create(**kwargs):
                        observed.append(kwargs['extra_headers']['X-Galaxy-Native-Run-Id'])
                        raise RuntimeError('fixture-stop-before-network')
                    async def acreate(**kwargs):
                        return create(**kwargs)
                    api = SimpleNamespace(create=acreate if mode.startswith('a') else create)
                    client = SimpleNamespace(chat=SimpleNamespace(completions=api), responses=api)
                    model.get_client = lambda: client
                    model.get_async_client = lambda: client
                    async def run():
                        token = _RUN.set(SimpleNamespace(run_id='native-run-exact'))
                        try:
                            try:
                                args = ([Message(role='user', content='fixture')], Message(role='assistant'))
                                if mode == 'invoke': model.invoke(*args)
                                elif mode == 'ainvoke': await model.ainvoke(*args)
                                elif mode == 'invoke_stream': list(model.invoke_stream(*args))
                                else:
                                    async for _ in model.ainvoke_stream(*args): pass
                            except Exception:
                                pass  # The SDK translates the deliberate provider fixture failure.
                        finally:
                            _RUN.reset(token)
                    asyncio.run(run())
                    self.assertEqual(observed, ['native-run-exact'])
