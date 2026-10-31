# Supplementary evidence for the profile-matched entry-path check

This package accompanies Supplementary File S3. It separates the complete run used for the four-operation result from an incomplete same-entity attempt. The incomplete attempt is retained for transparency and is not included in the reported counts.

## Complete run: run-HJxId0

The isolated deterministic simulator run passed all 24 recorded checks. It exercised a registered deterministic OMP-RPC fixture route and a direct REST route in cast-film/OPC UA and annealing/Modbus TCP. The four writes each returned a verified 1/1 platform receipt, and an independent device readback matched the requested value. The two routes within each scene used the same normalized configuration and candidate set but separate route-level entities and different candidate values. The fixture supplied the operation; no LLM inference, autonomous agent decision, or multi-agent collaboration occurred. The registered task remained SUBMITTED, and no post-write process sample was collected.

## Incomplete same-entity attempt: run-xtLwr7

This run is excluded from the four-operation result. The registered leg completed a cast-film 120-to-125 rpm write and independent readback. The direct REST leg timed out before a complete paired result. Its cleanup stop request also timed out; the process trees and loopback ports were subsequently checked and found stopped/released. It is not a passing run.

## Provenance and sanitization

The JSON records retain source and fixture hashes. The recorded execution-time runner hash for run-HJxId0 is `51c07c67361f3a6a6f991b438bce5f7283330b213fe97ab43c854a829c634b8e`. The exact runner source snapshot was not preserved. The current runner file has a different hash and is therefore not presented as the source used for that run. The included fixture source matches the fixture hash recorded by the complete run.

The shared copies remove project build-version fields and redact the corresponding version string from service logs. Unmodified raw records remain in the local audit archive at `docs/audit/evidence/paper-paired-route/`.
