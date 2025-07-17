import { RedisService } from "ondc-automation-cache-lib";
import { validationOutput } from "../types";

export function cancel(payload: any): validationOutput {
  // Extract payload, context, domain and action
  const context = payload?.context;
  const domain = context?.domain;
  const action = context?.action;
  console.log(`Running validations for ${domain}/${action}`);

  // Initialize results array
  const results: validationOutput = [];

  //validate items
  // if (!validateCancellationCodes (payload)) {
  //   results.push({
  //     valid: false,
  //     code: 60009,
  //     description: `The cancellation reason is not valid`,
  //   });
  // }

  // If no issues found, return a success result
  if (results.length === 0) {
    results.push({ valid: true, code: 200 });
  }

  return results;
}

/**
 * Validates that the items object is valid
 *
 * @param payload The request payload
 * @returns boolean indicating if validation passed
 */
// async function validateCancellationCodes(payload: Record<string, any>): Promise<boolean> {
//   const reasonId = payload?.message?.cancellation_reason_id;
//   const validCodes = [
//     "150", "151", "152", "153", "154", "155", "156", "175", "996", "994",
//     "250", "251", "252", "275"
//   ];

//   return validCodes.includes(reasonId)
// }
