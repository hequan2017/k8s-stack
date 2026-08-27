package kube

import (
	"errors"
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// HTTPStatusOf translates Kubernetes API errors into HTTP codes for API responses.
func HTTPStatusOf(err error) int {
	var se *apierrors.StatusError
	if errors.As(err, &se) && se.ErrStatus.Code >= 400 && se.ErrStatus.Code <= 599 {
		return int(se.ErrStatus.Code)
	}
	return http.StatusInternalServerError
}

func IsNotFound(err error) bool {
	return apierrors.IsNotFound(err)
}
