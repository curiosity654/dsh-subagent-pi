# Await in-process Pi quiescence

The one-shot plugin embeds the Pi SDK in the DSH process and therefore has no isolated worker it can safely force-terminate. Cancellation aborts Pi and waits for idle; disposal is idempotent and waits until listeners and session resources are actually released. Plugin unload rejects new starts, aborts active runs, and awaits the same disposal path. A slow-cleanup warning may be emitted, but no wall-clock timeout may report successful cleanup while Pi is still live.

The plugin admits at most four concurrent runs by default, counting setup through disposal, and rejects overflow before DSH publishes a run. It does not add an internal queue. This bounds resource use while keeping cancellation and publication semantics explicit; hard timeouts or forceful termination require a future out-of-process transport.
