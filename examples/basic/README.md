# examples/basic

fasti on Postgres with default names: a schema, a migration, and the same book-and-cancel story in the plain form (`plain.ts`) and the Effect form (`effect.ts`). `plain.ts` also blocks out lunch with a Block and shows `book` and `findSlots` respecting it, reschedules a Booking, and books with an `also` that spends a credit from a `pack` table of your own in the same transaction, vetoing when none is left. It registers two Policies: the prebuilt `notice`, relaxed to record a walk-in in the past, and a `maxThreePerDay` of its own that `book` and `findSlots` both honour. Each script exits non-zero on any unexpected outcome.

CI runs this on every push, and the [quickstart](../../README.md#quickstart) is copied from it, so changing it changes what the docs promise.

## Run it

```bash
# From the repo root: the example installs the built package (file:../..) as a copy.
bun run build

cd examples/basic
bun install --no-save  # again after every rebuild; the copy doesn't update itself
export DATABASE_URL=postgres://user:pass@localhost:5432/empty_db

bun run migrate  # once, on an empty database
bun run plain
bun run effect   # both can run again: each run uses a fresh Resource
```

Node 26 runs the `.ts` files directly; there is no build step here.
