import { ApiClient } from "@mondaydotcomorg/api";
import { env } from "../../config/env.js";

export const mondayClient = new ApiClient({ token: env.MONDAY_API_TOKEN });
