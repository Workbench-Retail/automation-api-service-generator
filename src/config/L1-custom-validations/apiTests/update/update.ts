import _ from "lodash";
import { RedisService } from "ondc-automation-cache-lib";
import constants from "../../utils//constants";
import { isPresentInRedisSet } from "../../utils//helper";
import { return_request_reasonCodes } from "../../utils//constants/reasonCode";
import { contextChecker } from "../../utils//contextUtils";

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

// Error codes
const ERROR_CODES = {
  FEATURE_NOT_SUPPORTED_BNP: 21001, // Feature not supported (BNP)
  INCREASE_ITEM_QUANTITY: 21002, // Increase in item quantity (BNP)
  CHANGE_ITEM_QUOTE: 21003, // Change in item quote (BNP)
  INVALID_PART_CANCEL_REQUEST: 22508, // Invalid Part Cancel Request (BNP)
  CANCEL_RETURN_REQUEST: 22509, // Cancel Return Request (BNP)
  ITEM_NOT_FOUND: 30004, // Item not found (SNP)
  INVALID_RETURN_REQUEST: 30005, // Invalid return request (SNP)
  INVALID_ORDER: 30018, // Invalid Order (SNP)
  ORDER_PROCESSING: 31003, // Order processing in progress (SNP)
  BUSINESS_ERROR: 40000, // Business Error (SNP)
  FEATURE_NOT_SUPPORTED_SNP: 40001, // Feature not supported (SNP)
  CHANGE_IN_QUOTE: 40008, // Change in quote (SNP)
  EXPIRED_AUTHORIZATION: 40010, // Expired authorization (SNP)
  INVALID_AUTHORIZATION: 40011, // Invalid authorization (SNP)
  POLICY_ERROR: 50000, // Policy Error (SNP)
  UPDATION_NOT_POSSIBLE: 50002, // Updation not possible (SNP)
  FULFILLMENT_NOT_FOUND: 50007, // Fulfillment not found (SNP)
  FULFILLMENT_CANNOT_UPDATE: 50008, // Fulfillment cannot be updated (SNP)
};

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const addError = (description: string, code: number): ValidationError => ({
  valid: false,
  code,
  description,
});

export const checkUpdate = async (
  data: any,
  settlementDetailSet: any,
  apiSeq = "update",
  targetFf: string
) => {
  const result: ValidationError[] = [];
  const { message, context }: any = data;
  try {
    try {
      await contextChecker(
        context,
        result,
        constants.UPDATE,
        constants.ON_CONFIRM,
        true
      );
    } catch (err: any) {
      result.push(
        addError(
          `Error checking context: ${err.message}`,
          ERROR_CODES.INVALID_ORDER
        )
      );

      return result;
    }

    const update = message.order;
    if (targetFf === "payment") {
      try {
        const payment = update.payment;
        if (payment) {
          const prevPaymentRaw = await RedisService.getKey(
            `${context.transaction_id}_prevPayment`
          );
          const prevPayment = prevPaymentRaw
            ? JSON.parse(prevPaymentRaw)
            : null;

          const settlement_details = payment["@ondc/org/settlement_details"];
          if (
            settlement_details[0] &&
            !isPresentInRedisSet(settlementDetailSet, settlement_details[0])
          ) {
            settlementDetailSet.add(settlement_details[0]);
          }

          prevPayment["@ondc/org/settlement_details"] = [
            ...settlementDetailSet,
          ];

          
          await RedisService.setKey(
            `${context.transaction_id}_prevPayment`,
            JSON.stringify(prevPayment),
            TTL_IN_SECONDS
          );

          await RedisService.setKey(
            `${context.transaction_id}_settlementDetailSet`,
            JSON.stringify([...settlementDetailSet]),
            TTL_IN_SECONDS
          );
          const quoteTrailSum = await RedisService.getKey(
            `${context.transaction_id}_quoteTrailSum`
          );

          if (
            settlement_details?.[0]?.settlement_amount &&
            quoteTrailSum &&
            Number(settlement_details?.[0]?.settlement_amount) !==
              Number(quoteTrailSum)
          ) {
            result.push(
              addError(
                `Settlement amount in payment object should be equal to the sum of quote trail i.e ${quoteTrailSum}`,
                ERROR_CODES.INVALID_ORDER
              )
            );
          }
        }
      } catch (error: any) {
        console.error(
          `!!Error occurred while checking for payment object in /${apiSeq} API`,
          error.stack
        );
      }
    }

    if (targetFf === "item") {
      try {
        console.info(`Checking for return_request object in /${apiSeq}`);
        let return_request_obj = null;
        let isReplace = false;
        update.fulfillments.forEach((item: any) => {
          item.tags?.forEach(async (tag: any) => {
            if (tag.code === "return_request") {
              return_request_obj = tag;

              if (!Array.isArray(tag.list)) {
                console.error(
                  `tag.list is missing or not an array in ${apiSeq}`
                );
                result.push(
                  addError(
                    `tag.list is missing or not an array in ${apiSeq}`,
                    ERROR_CODES.INVALID_RETURN_REQUEST
                  )
                );
                return;
              }

              const fields = tag.list.reduce(
                (acc: any, { code, value }: any) => {
                  acc[code] = value;
                  return acc;
                },
                {}
              );

              const mandatoryFields = [
                "id",
                "item_id",
                "item_quantity",
                "reason_id",
                "reason_desc",
              ];
              for (const field of mandatoryFields) {
                if (!fields[field] || fields[field].trim() === "") {
                  result.push(
                    addError(
                      `Missing or empty mandatory field: ${field} in ${apiSeq}`,
                      ERROR_CODES.INVALID_RETURN_REQUEST
                    )
                  );
                }
              }

              let selectItemList = null;
              try {
                const selectItemListRaw = await RedisService.getKey(
                  `${context.transaction_id}_SelectItemList`
                );
                selectItemList = selectItemListRaw
                  ? JSON.parse(selectItemListRaw)
                  : null;
              } catch (err) {
                result.push(
                  addError(
                    `Error fetching selectItemList from Redis in ${apiSeq}`,
                    ERROR_CODES.BUSINESS_ERROR
                  )
                );
              }

              if (fields.item_id && selectItemList) {
                const item = selectItemList.find(
                  (i: any) => i.item_id === fields.item_id
                );
                if (!item) {
                  result.push(
                    addError(
                      `Invalid item_id: ${fields.item_id} not found in selectItemList in ${apiSeq}`,
                      ERROR_CODES.ITEM_NOT_FOUND
                    )
                  );
                } else {
                  const quantity = parseInt(fields.item_quantity, 10);
                  if (isNaN(quantity) || quantity <= 0) {
                    result.push(
                      addError(
                        `item_quantity must be a positive integer in ${apiSeq}`,
                        ERROR_CODES.INVALID_RETURN_REQUEST
                      )
                    );
                  } else if (item.quantity && quantity > item.quantity) {
                    result.push(
                      addError(
                        `item_quantity (${quantity}) exceeds available quantity (${item.quantity}) for item_id: ${fields.item_id} in ${apiSeq}`,
                        ERROR_CODES.INCREASE_ITEM_QUANTITY
                      )
                    );
                  }
                }
              } else if (!selectItemList && fields.item_id) {
                result.push(
                  addError(
                    `selectItemList is not available for validation in ${apiSeq}`,
                    ERROR_CODES.BUSINESS_ERROR
                  )
                );
              }

              if (
                fields.reason_id &&
                !return_request_reasonCodes.includes(fields.reason_id)
              ) {
                result.push(
                  addError(
                    `Invalid reason_id: ${
                      fields.reason_id
                    }. Must be one of ${return_request_reasonCodes.join(
                      ", "
                    )} in ${apiSeq}`,
                    ERROR_CODES.INVALID_RETURN_REQUEST
                  )
                );
              }

              if (fields.images) {
                const urls = fields.images.split(",");
                const urlRegex = /^(https?:\/\/[^\s/$.?#].[^\s]*)$/;
                urls.forEach((url: any, index: any) => {
                  if (!urlRegex.test(url.trim())) {
                    result.push(
                      addError(
                        `Invalid URL in images at index ${index}: ${url} in ${apiSeq}`,
                        ERROR_CODES.INVALID_RETURN_REQUEST
                      )
                    );
                  }
                });
              }

              if (fields.ttl_approval) {
                try {
                  if (!/^P([0-9]+[YMDHMS])+$/.test(fields.ttl_approval)) {
                    result.push(
                      addError(
                        `Invalid ttl_approval format. Must be a valid ISO 8601 duration (e.g., PT24H) in ${apiSeq}`,
                        ERROR_CODES.INVALID_RETURN_REQUEST
                      )
                    );
                  }
                } catch (err) {
                  result.push(
                    addError(
                      `Error parsing ttl_approval duration in ${apiSeq}`,
                      ERROR_CODES.INVALID_RETURN_REQUEST
                    )
                  );
                }
              }

              if (fields.ttl_reverseqc) {
                try {
                  if (!/^P([0-9]+[YMDHMS])+$/.test(fields.ttl_reverseqc)) {
                    result.push(
                      addError(
                        `Invalid ttl_reverseqc format. Must be a valid ISO 8601 duration (e.g., P3D) in ${apiSeq}`,
                        ERROR_CODES.INVALID_RETURN_REQUEST
                      )
                    );
                  }
                } catch (err) {
                  result.push(
                    addError(
                      `Error parsing ttl_reverseqc duration in ${apiSeq}`,
                      ERROR_CODES.INVALID_RETURN_REQUEST
                    )
                  );
                }
              }
              if (fields.replace) {
                if (fields.replace == "yes") {
                  isReplace = true;
                  await RedisService.setKey(
                    `${context.transaction_id}_replaceable`,
                    "true",
                    TTL_IN_SECONDS
                  );
                }
              }
            }
          });
        });
      } catch (error: any) {
        console.error(
          `Error while checking for return_request_obj for /${apiSeq} , ${error}`
        );
      }
    }

    return result;
  } catch (error: any) {
    console.error(
      `!!Some error occurred while checking /${apiSeq} API`,
      error.stack
    );
    return [
      addError(
        `Internal error while checking /${apiSeq} API`,
        ERROR_CODES.BUSINESS_ERROR
      ),
    ];
  }
};
