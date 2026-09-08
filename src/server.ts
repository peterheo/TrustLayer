/**
 * The deployable entry point.
 *
 *   pnpm start
 *
 * Everything it needs comes from the environment (see .env.example and
 * arena/DEPLOYMENT.md). Nothing about the verification protocol changes when it
 * runs behind HTTP: the same bounded SharedOS turn produces the same receipt.
 */
import { serve } from "./api/http.js";

await serve();
